import {
  WebhookPayload,
  WebhookResponse,
  BatchItem,
  LogVaultConfig,
} from "../types";
import { HttpTransport } from "./http";

export class BatchTransport {
  private queue: BatchItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly http: HttpTransport;
  private readonly batchSize: number;
  private readonly batchInterval: number;
  private readonly debug: boolean;

  constructor(config: LogVaultConfig, http: HttpTransport) {
    this.http = http;
    this.batchSize = config.batchSize ?? 50;
    this.batchInterval = config.batchInterval ?? 5000;
    this.debug = config.debug ?? false;

    this.startTimer();
  }

  add(payload: WebhookPayload): Promise<WebhookResponse> {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });

      if (this.queue.length >= this.batchSize) {
        this.flush();
      }
    });
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const items = this.queue.splice(0, this.batchSize);

    if (this.debug) {
      console.debug(`[LogVault] Flushing batch of ${items.length} events`);
    }

    try {
      const results = await this.http.sendBatch(items.map((i) => i.payload));

      items.forEach((item, idx) => {
        const result = results[idx];
        if (result && result.success) {
          item.resolve(result);
        } else {
          item.reject(new Error(result?.error || "Batch send failed"));
        }
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      items.forEach((item) => item.reject(err));
    }
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      this.flush();
    }, this.batchInterval);

    // Don't block process exit in Node.js
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Flush remaining
    this.flush();
  }

  get pending(): number {
    return this.queue.length;
  }
}
