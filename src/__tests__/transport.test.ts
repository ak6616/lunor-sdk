import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Transport } from "../transport";
import type { LunorConfig, WebhookPayload } from "../types";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeConfig(overrides: Partial<LunorConfig> = {}): LunorConfig {
  return {
    apiKey: "key",
    apiSecret: "secret",
    endpoint: "https://example.com/api/webhook",
    maxRetries: 0, // no retries by default to keep tests fast
    retryBaseDelay: 10,
    retryMaxDelay: 100,
    timeout: 5000,
    ...overrides,
  };
}

function makePayload(): WebhookPayload {
  return { type: "log", data: { message: "hello" } as never };
}

describe("Transport", () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    logger = makeLogger();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("send — success", () => {
    it("returns success response when fetch resolves with ok", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "evt1", type: "log" }),
        text: async () => "",
      });

      const t = new Transport(makeConfig(), logger);
      const result = await t.send(makePayload());

      expect(result.success).toBe(true);
      expect(result.id).toBe("evt1");
    });
  });

  describe("send — non-retryable 4xx", () => {
    it("returns failure without throwing for 400 errors", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "Bad Request",
      });

      const t = new Transport(makeConfig(), logger);
      const result = await t.send(makePayload());

      expect(result.success).toBe(false);
      expect(result.error).toContain("400");
      expect(logger.error).toHaveBeenCalled();
    });

    it("does not treat 429 as non-retryable — retries and eventually throws", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => "Rate limited",
      });

      const t = new Transport(makeConfig({ maxRetries: 1 }), logger);
      const promise = t.send(makePayload());
      const caught = promise.catch((e: Error) => e);
      await vi.runAllTimersAsync();

      // 429 is retried, so after exhausting retries withRetry throws (not a noRetry return)
      const err = await caught;
      expect((err as Error).message).toContain("HTTP 429");
    });
  });

  describe("send — 5xx server errors (retried)", () => {
    it("retries and eventually returns failure after max retries for 500", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Server Error",
      });

      const t = new Transport(makeConfig({ maxRetries: 1 }), logger);
      const promise = t.send(makePayload());
      const caught = promise.catch((e: Error) => e);
      await vi.runAllTimersAsync();
      const err = await caught;
      expect((err as Error).message).toContain("HTTP 500");
    });
  });

  describe("send — timeout", () => {
    it("aborts the request when timeout is exceeded", async () => {
      global.fetch = vi.fn().mockImplementation(
        (_url: string, options: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            if (options?.signal) {
              options.signal.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              });
            }
          });
        }
      );

      const t = new Transport(makeConfig({ timeout: 100, maxRetries: 0 }), logger);
      const promise = t.send(makePayload());

      // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
      const caught = promise.catch((e: Error) => e);

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      const err = await caught;
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("sendBatch", () => {
    it("sends all payloads and returns results", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "e1", type: "log" }),
      });

      const t = new Transport(makeConfig(), logger);
      const payloads = [makePayload(), makePayload(), makePayload()];
      const results = await t.sendBatch(payloads);

      expect(results).toHaveLength(3);
      results.forEach((r) => expect(r.success).toBe(true));
    });

    it("marks failed payloads as unsuccessful in results", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: "e1", type: "log" }),
        })
        .mockResolvedValue({
          ok: false,
          status: 400,
          text: async () => "Bad Request",
        });

      const t = new Transport(makeConfig(), logger);
      const results = await t.sendBatch([makePayload(), makePayload()]);

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });

    it("handles batches larger than concurrency limit (5)", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "e1", type: "log" }),
      });

      const t = new Transport(makeConfig(), logger);
      const payloads = Array.from({ length: 12 }, makePayload);
      const results = await t.sendBatch(payloads);

      expect(results).toHaveLength(12);
      expect(fetch).toHaveBeenCalledTimes(12);
    });

    it("handles rejected promises in batch gracefully", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("network down"));

      const t = new Transport(makeConfig({ maxRetries: 0 }), logger);
      const promise = t.sendBatch([makePayload()]);
      await vi.runAllTimersAsync();

      // withRetry exhausts retries, Promise.allSettled catches it
      const results = await promise;
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("network down");
    });

    it("returns empty array for empty input", async () => {
      const t = new Transport(makeConfig(), logger);
      const results = await t.sendBatch([]);
      expect(results).toEqual([]);
    });
  });
});
