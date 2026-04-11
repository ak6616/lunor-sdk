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
   * Send a batch of payloads
   */
  async sendBatch(payloads: WebhookPayload[]): Promise<TransportResponse[]> {
    const results: TransportResponse[] = [];

    // Send payloads concurrently with concurrency limit
    const concurrencyLimit = 5;
    for (let i = 0; i < payloads.length; i += concurrencyLimit) {
      const chunk = payloads.slice(i, i + concurrencyLimit);
      const chunkResults = await Promise.allSettled(
        chunk.map((payload) => this.send(payload)),
      );

      for (const result of chunkResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            success: false,
            error: result.reason?.message || "Unknown error",
          });
        }
      }
    }

    return results;
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
