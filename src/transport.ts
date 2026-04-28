// src/transport.ts

import type { WebhookPayload, TransportResponse, LunorConfig } from "./types";
import { HEADER_API_KEY } from "./constants";
import { withRetry } from "./retry";
import { signRequest } from "./hmac";
import { enforceTransportSize } from "./validation";
import { scrubSensitive } from "./scrubber";
import type { createInternalLogger } from "./utils";

export class Transport {
  private config: LunorConfig;
  private logger: ReturnType<typeof createInternalLogger>;

  constructor(
    config: LunorConfig,
    logger: ReturnType<typeof createInternalLogger>,
  ) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Send a single payload to the webhook endpoint
   */
  async send(payload: WebhookPayload): Promise<TransportResponse> {
    return withRetry(() => this.doSend(payload), {
      maxRetries: this.config.maxRetries ?? 3,
      baseDelay: this.config.retryBaseDelay ?? 1000,
      maxDelay: this.config.retryMaxDelay ?? 30000,
      onRetry: (attempt, error) => {
        this.logger.warn(
          `Retry attempt ${attempt} for ${payload.type}: ${error.message}`,
        );
      },
    });
  }

  /**
   * Send a batch of payloads in a single HTTP request using the {events:[...]}
   * envelope. Server (lunor /api/webhook >= Plan 2) accepts both single-event
   * and batched formats. Falls back to per-event sends if the server returns
   * 4xx on the batch (e.g. older deploy without batched support).
   *
   * MAX_EVENTS_PER_BATCH on the server is 100 — caller (LunorClient.flush)
   * already drives flushing by batchSize so we just chunk at that limit here
   * as a safety net.
   */
  async sendBatch(payloads: WebhookPayload[]): Promise<TransportResponse[]> {
    if (payloads.length === 0) return [];
    if (payloads.length === 1) {
      // Single event — use the legacy path so response shape stays consistent
      // (no overhead from batch envelope for a 1-event flush).
      return [await this.send(payloads[0])];
    }

    const results: TransportResponse[] = [];
    const MAX_PER_BATCH = 100;
    for (let i = 0; i < payloads.length; i += MAX_PER_BATCH) {
      const chunk = payloads.slice(i, i + MAX_PER_BATCH);
      try {
        const batchResults = await withRetry(() => this.doSendBatch(chunk), {
          maxRetries: this.config.maxRetries ?? 3,
          baseDelay: this.config.retryBaseDelay ?? 1000,
          maxDelay: this.config.retryMaxDelay ?? 30000,
          onRetry: (attempt, error) => {
            this.logger.warn(
              `Retry attempt ${attempt} for batch of ${chunk.length}: ${error.message}`,
            );
          },
        });
        results.push(...batchResults);
      } catch (e) {
        // Catastrophic failure — mark all events in this chunk as failed.
        const message = e instanceof Error ? e.message : String(e);
        for (let j = 0; j < chunk.length; j++) {
          results.push({ success: false, error: message });
        }
      }
    }
    return results;
  }

  private async doSendBatch(
    payloads: WebhookPayload[],
  ): Promise<TransportResponse[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeout ?? 10000,
    );

    try {
      const scrubbed = payloads.map(
        (p) => scrubSensitive(p) as WebhookPayload,
      );
      const envelope = { events: scrubbed };
      const rawBody = JSON.stringify(envelope);

      const checked = enforceTransportSize(rawBody, "fetch", this.logger);
      if (checked === null) {
        // Batch too big for a single fetch — caller will fan out to single sends.
        const error = new Error("Batch payload exceeds max fetch size");
        (error as unknown as Record<string, unknown>).noRetry = true;
        throw error;
      }

      const signed = await signRequest(this.config.apiSecret, checked);

      const response = await fetch(this.config.endpoint!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [HEADER_API_KEY]: this.config.apiKey,
          ...signed,
        },
        body: checked,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await response.text().catch(() => "No body");

        // 400 on the batch could mean the server doesn't support {events:[]}
        // yet (very old lunor deployment). Fall back to per-event sends so
        // upgrades aren't blocked on coordinated rollout.
        if (response.status === 400) {
          this.logger.warn(
            "Batch rejected with 400 — falling back to per-event sends",
          );
          const fallback: TransportResponse[] = [];
          for (const payload of payloads) {
            fallback.push(await this.send(payload));
          }
          return fallback;
        }

        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          const error = new Error(`HTTP ${response.status}: ${body}`);
          (error as unknown as Record<string, unknown>).noRetry = true;
          throw error;
        }

        throw new Error(`HTTP ${response.status}: ${body}`);
      }

      const json = (await response.json()) as {
        success?: boolean;
        count?: number;
        events?: { id: string; type: string }[];
      };

      const acked = Array.isArray(json.events) ? json.events : [];
      const results: TransportResponse[] = [];
      for (let i = 0; i < payloads.length; i++) {
        const ack = acked[i];
        if (ack && typeof ack.id === "string") {
          results.push({ success: true, id: ack.id, type: ack.type });
        } else {
          results.push({ success: true });
        }
      }
      return results;
    } catch (error) {
      clearTimeout(timeoutId);

      if ((error as Record<string, unknown>).noRetry) {
        this.logger.error(
          `Non-retryable batch error: ${(error as Error).message}`,
        );
        return payloads.map(() => ({
          success: false,
          error: (error as Error).message,
        }));
      }
      throw error;
    }
  }

  private async doSend(payload: WebhookPayload): Promise<TransportResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeout ?? 10000,
    );

    try {
      // Defensive final scrub — should already be sanitized upstream by the
      // client, but we never want raw secrets leaving the process.
      const scrubbed = scrubSensitive(payload) as WebhookPayload;

      // Compute the raw body ONCE — the HMAC signature must cover exactly
      // the bytes we send, so we reuse the same string for signing and body.
      const rawBody = JSON.stringify(scrubbed);

      const checked = enforceTransportSize(rawBody, "fetch", this.logger);
      if (checked === null) {
        const error = new Error("Payload exceeds max fetch size");
        (error as unknown as Record<string, unknown>).noRetry = true;
        throw error;
      }

      const signed = await signRequest(this.config.apiSecret, checked);

      const response = await fetch(this.config.endpoint!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [HEADER_API_KEY]: this.config.apiKey,
          ...signed,
        },
        body: checked,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await response.text().catch(() => "No body");

        // Don't retry 4xx client errors (except 429 — rate limit)
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          const error = new Error(`HTTP ${response.status}: ${body}`);
          (error as unknown as Record<string, unknown>).noRetry = true;
          throw error;
        }

        throw new Error(`HTTP ${response.status}: ${body}`);
      }

      const json = await response.json();
      return {
        success: true,
        id: json.id,
        type: json.type,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if ((error as Record<string, unknown>).noRetry) {
        this.logger.error(`Non-retryable error: ${(error as Error).message}`);
        return {
          success: false,
          error: (error as Error).message,
        };
      }

      throw error;
    }
  }
}
