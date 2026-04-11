// src/queue.ts

import type { QueueItem, WebhookPayload } from "./types";
import { generateId, safeParse, safeStringify } from "./utils";
import type { createInternalLogger } from "./utils";
import { scrubSensitive } from "./scrubber";

// Persistence TTL lowered from 24h to 2h — shrinks the window during which
// any (already-sanitized) event could sit in localStorage.
const PERSIST_TTL_MS = 2 * 60 * 60 * 1000;

// Hard caps on what we write to localStorage. The client is expected to scrub
// upstream; these are a last-line defense against a single runaway payload
// filling the user's storage or exposing PII long-term.
const MAX_PERSIST_ITEM_BYTES = 8 * 1024; // 8KB per event
const MAX_PERSIST_TOTAL_BYTES = 1024 * 1024; // 1MB total

export class PersistentQueue {
  private items: QueueItem[] = [];
  private maxSize: number;
  private storageKey: string;
  private enablePersistence: boolean;
  private logger: ReturnType<typeof createInternalLogger>;

  constructor(
    maxSize: number,
    storageKey: string,
    enablePersistence: boolean,
    logger: ReturnType<typeof createInternalLogger>,
  ) {
    this.maxSize = maxSize;
    this.storageKey = storageKey;
    this.enablePersistence = enablePersistence;
    this.logger = logger;

    this.restore();
  }

  /**
   * Add an item to the queue
   */
  enqueue(payload: WebhookPayload): void {
    if (this.items.length >= this.maxSize) {
      // Drop oldest item (FIFO eviction)
      const dropped = this.items.shift();
      this.logger.warn(
        `Queue full (${this.maxSize}), dropping oldest item: ${dropped?.id}`,
      );
    }

    const item: QueueItem = {
      id: generateId(),
      payload,
      retries: 0,
      createdAt: Date.now(),
    };

    this.items.push(item);
    this.persist();
  }

  /**
   * Take up to `count` items from the front of the queue
   */
  dequeue(count: number): QueueItem[] {
    const taken = this.items.splice(0, count);
    this.persist();
    return taken;
  }

  /**
   * Return items to the front of the queue (for retry)
   */
  requeue(items: QueueItem[]): void {
    // Increment retry counts and update lastAttempt
    const updatedItems = items.map((item) => ({
      ...item,
      retries: item.retries + 1,
      lastAttempt: Date.now(),
    }));

    this.items.unshift(...updatedItems);

    // Enforce max size
    if (this.items.length > this.maxSize) {
      this.items = this.items.slice(0, this.maxSize);
    }

    this.persist();
  }

  /**
   * Get current queue size
   */
  get size(): number {
    return this.items.length;
  }

  /**
   * Check if queue is empty
   */
  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Get all items (without removing)
   */
  peek(): QueueItem[] {
    return [...this.items];
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.items = [];
    this.persist();
  }

  /**
   * Drain the entire queue
   */
  drain(): QueueItem[] {
    const all = [...this.items];
    this.items = [];
    this.persist();
    return all;
  }

  /**
   * Persist queue to storage.
   *
   * Security posture:
   *   - Only SCRUBBED copies of each payload are written. The scrubber is
   *     idempotent, so running it again here is a cheap defensive check even
   *     though upstream (client.log / client.captureError) already sanitizes.
   *   - Items serializing larger than MAX_PERSIST_ITEM_BYTES are skipped.
   *   - Once the serialized total exceeds MAX_PERSIST_TOTAL_BYTES we stop.
   */
  private persist(): void {
    if (!this.enablePersistence) return;

    try {
      if (typeof localStorage === "undefined") return;

      const sanitized: QueueItem[] = [];
      let totalBytes = 0;

      for (const item of this.items) {
        const sanitizedItem: QueueItem = {
          ...item,
          payload: scrubSensitive(item.payload) as WebhookPayload,
        };
        const serialized = safeStringify(sanitizedItem);
        const size = serialized.length;

        if (size > MAX_PERSIST_ITEM_BYTES) {
          this.logger.warn(
            `Queue item ${item.id} is ${size}B > ${MAX_PERSIST_ITEM_BYTES}B — skipping persistence`,
          );
          continue;
        }
        if (totalBytes + size > MAX_PERSIST_TOTAL_BYTES) {
          this.logger.warn(
            `Persistence budget exhausted (${MAX_PERSIST_TOTAL_BYTES}B) — truncating`,
          );
          break;
        }
        sanitized.push(sanitizedItem);
        totalBytes += size;
      }

      localStorage.setItem(this.storageKey, safeStringify(sanitized));
    } catch (error) {
      this.logger.debug("Failed to persist queue:", error);
    }
  }

  /**
   * Restore queue from storage. Items older than PERSIST_TTL_MS are dropped.
   */
  private restore(): void {
    if (!this.enablePersistence) return;

    try {
      if (typeof localStorage !== "undefined") {
        const stored = localStorage.getItem(this.storageKey);
        if (stored) {
          const parsed = safeParse<QueueItem[]>(stored, []);
          this.items = parsed.filter(
            (item) => Date.now() - item.createdAt < PERSIST_TTL_MS,
          );

          if (this.items.length > 0) {
            this.logger.info(
              `Restored ${this.items.length} items from persistence`,
            );
          }
        }
      }
    } catch (error) {
      this.logger.debug("Failed to restore queue:", error);
    }
  }
}
