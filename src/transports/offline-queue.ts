import { QueuedEvent, WebhookPayload, LogVaultConfig } from "../types";
import { HttpTransport } from "./http";

export class OfflineQueue {
  private queue: QueuedEvent[] = [];
  private readonly maxSize: number;
  private readonly debug: boolean;
  private processing = false;

  constructor(
    config: LogVaultConfig,
    private readonly http: HttpTransport,
  ) {
    this.maxSize = config.maxOfflineQueueSize ?? 500;
    this.debug = config.debug ?? false;
  }

  enqueue(payload: WebhookPayload): void {
    if (this.queue.length >= this.maxSize) {
      // Drop oldest
      this.queue.shift();
      if (this.debug) {
        console.warn("[LogVault] Offline queue full — dropping oldest event");
      }
    }

    this.queue.push({
      payload,
      timestamp: Date.now(),
      retries: 0,
    });

    if (this.debug) {
      console.debug(
        `[LogVault] Queued offline event (${this.queue.length} in queue)`,
      );
    }
  }

  async drain(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    if (this.debug) {
      console.debug(
        `[LogVault] Draining offline queue (${this.queue.length} events)`,
      );
    }

    while (this.queue.length > 0) {
      const event = this.queue[0];

      try {
        await this.http.send(event.payload);
        this.queue.shift(); // Remove on success
      } catch {
        event.retries++;
        if (event.retries >= 3) {
          this.queue.shift(); // Drop after max retries
          if (this.debug) {
            console.warn("[LogVault] Dropping event after max retries");
          }
        } else {
          break; // Stop draining — still offline
        }
      }
    }

    this.processing = false;
  }

  get size(): number {
    return this.queue.length;
  }
}
