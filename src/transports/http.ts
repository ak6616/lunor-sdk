import { WebhookPayload, WebhookResponse, LogVaultConfig } from "../types";
import { withRetry } from "../utils/retry";

export class HttpTransport {
  private config: Required<
    Pick<
      LogVaultConfig,
      | "apiKey"
      | "apiSecret"
      | "endpoint"
      | "timeout"
      | "maxRetries"
      | "retryDelay"
      | "debug"
    >
  >;

  constructor(config: LogVaultConfig) {
    this.config = {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      endpoint: config.endpoint.replace(/\/$/, ""),
      timeout: config.timeout ?? 10000,
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
      debug: config.debug ?? false,
    };
  }

  async send(payload: WebhookPayload): Promise<WebhookResponse> {
    return withRetry(() => this.doSend(payload), {
      maxRetries: this.config.maxRetries,
      baseDelay: this.config.retryDelay,
      onRetry: (attempt, error) => {
        if (this.config.debug) {
          console.warn(
            `[LogVault] Retry ${attempt}/${this.config.maxRetries}: ${error.message}`,
          );
        }
      },
    });
  }

  async sendBatch(payloads: WebhookPayload[]): Promise<WebhookResponse[]> {
    // The webhook endpoint processes one event at a time,
    // so we send them concurrently with a concurrency limit.
    const results: WebhookResponse[] = [];
    const concurrency = 5;

    for (let i = 0; i < payloads.length; i += concurrency) {
      const chunk = payloads.slice(i, i + concurrency);
      const chunkResults = await Promise.allSettled(
        chunk.map((p) => this.send(p)),
      );

      for (const result of chunkResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            success: false,
            error: result.reason?.message ?? "Unknown error",
          });
        }
      }
    }

    return results;
  }

  private async doSend(payload: WebhookPayload): Promise<WebhookResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      if (this.config.debug) {
        console.debug(
          `[LogVault] Sending ${payload.type}:`,
          JSON.stringify(payload.data).slice(0, 200),
        );
      }

      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.config.apiKey,
          "X-API-Secret": this.config.apiSecret,
          "User-Agent": "LogVault-SDK/1.0.0",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const data: WebhookResponse = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      return data;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`Request timed out after ${this.config.timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
