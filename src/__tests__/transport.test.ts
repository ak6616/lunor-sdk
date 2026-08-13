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
      // Prawdziwe timery: backoff to tu 10–20 ms, więc udawanie czasu nic nie
      // oszczędza, a wprowadza wyścig. `doSend` czeka na `signRequest`
      // (WebCrypto), przez co timer backoffu powstaje dopiero po realnej
      // operacji asynchronicznej — pod obciążeniem drenaż fake timerów kończył
      // się wcześniej i test wisiał do 5-sekundowego timeoutu.
      vi.useRealTimers();

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => "Rate limited",
      });

      const t = new Transport(makeConfig({ maxRetries: 1 }), logger);
      const err = await t.send(makePayload()).catch((e: Error) => e);

      // Rzut, a nie `{success:false}` — 429 idzie ścieżką ponawianą.
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("HTTP 429");
      // Sedno testu: próba pierwotna + jedno ponowienie. Gdyby 429 wpadło
      // do gałęzi `noRetry`, wywołanie byłoby dokładnie jedno.
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("send — 5xx server errors (retried)", () => {
    it("retries and eventually returns failure after max retries for 500", async () => {
      // Prawdziwe timery — powód jak przy teście 429 wyżej.
      vi.useRealTimers();

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Server Error",
      });

      const t = new Transport(makeConfig({ maxRetries: 1 }), logger);
      const err = await t.send(makePayload()).catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("HTTP 500");
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("send — timeout", () => {
    it("aborts the request when timeout is exceeded", async () => {
      // Atrapa musi odwzorować `fetch` także wtedy, gdy sygnał jest JUŻ
      // przerwany w momencie wywołania — prawdziwy `fetch` odrzuca wtedy
      // natychmiast, zamiast czekać na zdarzenie `abort`.
      //
      // To nie jest szczegół: `doSend` planuje timeout PRZED `await
      // signRequest` (WebCrypto), więc przy timeoucie 100 ms `abort()` odpala
      // się, zanim wykonanie dojdzie do `fetch`. Poprzednia wersja
      // rejestrowała wtedy nasłuch na zdarzenie, które już się wydarzyło —
      // promise nigdy się nie rozstrzygał i test wisiał do 5-sekundowego
      // timeoutu vitesta.
      global.fetch = vi.fn().mockImplementation(
        (_url: string, options: { signal?: AbortSignal }) => {
          const abortError = () =>
            new DOMException("The operation was aborted.", "AbortError");

          if (options?.signal?.aborted) {
            return Promise.reject(abortError());
          }

          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(abortError()));
          });
        }
      );

      const t = new Transport(makeConfig({ timeout: 100, maxRetries: 0 }), logger);
      // `.catch` podpięty od razu — inaczej między `send` a asercją byłoby
      // okno na „unhandled rejection".
      const caught = t.send(makePayload()).catch((e: Error) => e);

      vi.advanceTimersByTime(200);

      const err = await caught;
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("sendBatch", () => {
    it("sends multiple payloads in one batched request", async () => {
      // True batching: N events → 1 HTTP request with {events:[...]} envelope.
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          count: 3,
          events: [
            { id: "e1", type: "log" },
            { id: "e2", type: "log" },
            { id: "e3", type: "log" },
          ],
        }),
      });

      const t = new Transport(makeConfig(), logger);
      const payloads = [makePayload(), makePayload(), makePayload()];
      const results = await t.sendBatch(payloads);

      expect(results).toHaveLength(3);
      results.forEach((r) => expect(r.success).toBe(true));
      expect(fetch).toHaveBeenCalledTimes(1);
      const callArgs = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
      const body = JSON.parse((callArgs[1] as { body: string }).body);
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events).toHaveLength(3);
    });

    it("falls back to per-event sends when server returns 400 on batch", async () => {
      // Old server (pre-Plan 2) doesn't accept {events:[]} → 400.
      // SDK should retry each event individually using legacy single format.
      global.fetch = vi
        .fn()
        // Batched call → 400
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => "Invalid payload format",
        })
        // Per-event fallback calls succeed
        .mockResolvedValue({
          ok: true,
          json: async () => ({ id: "fallback-id", type: "log" }),
        });

      const t = new Transport(makeConfig(), logger);
      const results = await t.sendBatch([makePayload(), makePayload()]);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
      // 1 batched + 2 per-event = 3 calls
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("chunks batches > 100 events", async () => {
      global.fetch = vi.fn().mockImplementation((_url, options) => {
        const body = JSON.parse((options as { body: string }).body);
        const events = body.events as unknown[];
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            count: events.length,
            events: events.map((_, i) => ({ id: `e${i}`, type: "log" })),
          }),
        });
      });

      const t = new Transport(makeConfig(), logger);
      const payloads = Array.from({ length: 250 }, makePayload);
      const results = await t.sendBatch(payloads);

      expect(results).toHaveLength(250);
      // 250 events → 100 + 100 + 50 = 3 batched requests
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("marks all events failed when batch fetch rejects after retries", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("network down"));

      const t = new Transport(makeConfig({ maxRetries: 0 }), logger);
      const promise = t.sendBatch([makePayload(), makePayload()]);
      await vi.runAllTimersAsync();

      const results = await promise;
      expect(results).toHaveLength(2);
      results.forEach((r) => {
        expect(r.success).toBe(false);
        expect(r.error).toContain("network down");
      });
    });

    it("uses single-send path when given exactly 1 payload", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "single", type: "log" }),
      });

      const t = new Transport(makeConfig(), logger);
      const results = await t.sendBatch([makePayload()]);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      // Single-event path → bare {type,data}, not wrapped in events:[]
      const callArgs = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
      const body = JSON.parse((callArgs[1] as { body: string }).body);
      expect(body.events).toBeUndefined();
      expect(body.type).toBeDefined();
    });

    it("returns empty array for empty input", async () => {
      const t = new Transport(makeConfig(), logger);
      const results = await t.sendBatch([]);
      expect(results).toEqual([]);
    });
  });
});
