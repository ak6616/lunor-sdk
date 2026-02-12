// src/queue.ts

import type { QueueItem, WebhookPayload } from "./types";
import { generateId, safeParse, safeStringify } from "./utils";
import type { createInternalLogger } from "./utils";

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
   * Persist queue to storage
   */
  private persist(): void {
    if (!this.enablePersistence) return;

    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(this.storageKey, safeStringify(this.items));
      }
    } catch (error) {
      this.logger.debug("Failed to persist queue:", error);
    }
  }

  /**
   * Restore queue from storage
   */
  private restore(): void {
    if (!this.enablePersistence) return;

    try {
      if (typeof localStorage !== "undefined") {
        const stored = localStorage.getItem(this.storageKey);
        if (stored) {
          const parsed = safeParse<QueueItem[]>(stored, []);
          this.items = parsed.filter(
            // Only restore items less than 24h old
            (item) => Date.now() - item.createdAt < 24 * 60 * 60 * 1000,
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
