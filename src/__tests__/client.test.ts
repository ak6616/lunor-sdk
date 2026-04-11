import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LunorClient } from "../client";
import { LogLevel, Severity, ErrorType, SecurityType } from "../types";

// Suppress internal SDK warnings/errors during tests unless needed
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeFetch(ok = true, body: unknown = { id: "e1", type: "log" }) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function makeClient(overrides = {}) {
  return new LunorClient({
    apiKey: "test-key",
    apiSecret: "test-secret",
    endpoint: "https://example.com/api/webhook",
    flushInterval: 999999, // disable auto-flush
    captureGlobalErrors: false,
    captureUnhandledRejections: false,
    captureConsole: false,
    enablePersistence: false,
    maxRetries: 0,
    sampleRate: 1.0,
    environment: "test",
    ...overrides,
  });
}

describe("LunorClient — constructor", () => {
  it("throws when apiKey is missing", () => {
    expect(() =>
      new LunorClient({ apiKey: "", apiSecret: "s" })
    ).toThrow("apiKey and apiSecret are required");
  });

  it("throws when apiSecret is missing", () => {
    expect(() =>
      new LunorClient({ apiKey: "k", apiSecret: "" })
    ).toThrow("apiKey and apiSecret are required");
  });

  it("constructs successfully with required fields", () => {
    const client = makeClient();
    expect(client).toBeInstanceOf(LunorClient);
    client.destroy();
  });

  it("calls onReady callback after construction", () => {
    const onReady = vi.fn();
    const client = makeClient({ onReady });
    expect(onReady).toHaveBeenCalledOnce();
    client.destroy();
  });

  it("warns and overrides custom endpoint in production", () => {
    const client = new LunorClient({
      apiKey: "k",
      apiSecret: "s",
      endpoint: "https://custom.example.com/api",
      environment: "production",
      captureGlobalErrors: false,
      captureUnhandledRejections: false,
    });
    expect(console.warn).toHaveBeenCalled();
    client.destroy();
  });
});

describe("LunorClient — getStats", () => {
  it("reports initial state", () => {
    const client = makeClient();
    const stats = client.getStats();
    expect(stats.state).toBe("ready");
    expect(stats.queueSize).toBe(0);
    expect(stats.totalEvents).toBe(0);
    client.destroy();
  });
});

describe("LunorClient — log / debug / info / warn / errorLog / fatal", () => {
  it("log enqueues a log event", () => {
    const client = makeClient();
    client.log("hello");
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });

  it("debug convenience shortcut sets DEBUG level", () => {
    const client = makeClient({ minLogLevel: LogLevel.DEBUG });
    client.debug("msg");
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });

  it("info shortcut enqueues", () => {
    const client = makeClient();
    client.info("msg");
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });

  it("warn shortcut enqueues", () => {
    const client = makeClient();
    client.warn("msg");
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });

  it("errorLog shortcut enqueues as log (not error event)", () => {
    const client = makeClient();
    client.errorLog("msg");
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });

  it("accepts LogPayload object", () => {
    const client = makeClient();
    client.log({ level: LogLevel.WARN, message: "warn message" });
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });

  it("drops events below minLogLevel", () => {
    const client = makeClient({ minLogLevel: LogLevel.ERROR });
    client.debug("debug msg");
    client.info("info msg");
    expect(client.getStats().totalEvents).toBe(0);
    client.destroy();
  });
});

describe("LunorClient — captureError", () => {
  it("accepts a string", () => {
    const client = makeClient();
    client.captureError("error string");
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });

  it("accepts an Error object", () => {
    const client = makeClient();
    client.captureError(new Error("boom"));
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });

  it("accepts an ErrorPayload object", () => {
    const client = makeClient();
    client.captureError({
      message: "payload error",
      severity: Severity.HIGH,
      type: ErrorType.RUNTIME,
    });
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });

  it("captureException shortcut works", () => {
    const client = makeClient();
    client.captureException(new Error("ex"));
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });
});

describe("LunorClient — captureDebug", () => {
  it("enqueues a debug event", () => {
    const client = makeClient();
    client.captureDebug({ type: "test", data: { foo: 1 } });
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });
});

describe("LunorClient — captureSecurityEvent", () => {
  it("enqueues a security event", () => {
    const client = makeClient();
    global.fetch = makeFetch();
    client.captureSecurityEvent({
      type: SecurityType.BRUTE_FORCE,
      description: "too many attempts",
    });
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });
});

describe("LunorClient — performance timing", () => {
  it("startTimer / stopTimer returns a mark with duration", () => {
    const client = makeClient();

    client.startTimer("op");
    const mark = client.stopTimer("op", false);

    expect(mark).not.toBeNull();
    expect(mark!.duration).toBeGreaterThanOrEqual(0);
    client.destroy();
  });

  it("stopTimer returns null for unknown mark", () => {
    const client = makeClient();
    const result = client.stopTimer("unknown", false);
    expect(result).toBeNull();
    client.destroy();
  });

  it("measure resolves and returns the result", async () => {
    const client = makeClient();
    global.fetch = makeFetch();

    const result = await client.measure("op", async () => 42);

    expect(result).toBe(42);
    client.destroy();
  });

  it("measure re-throws errors and captures an error event", async () => {
    const client = makeClient();
    global.fetch = makeFetch();

    await expect(
      client.measure("op", async () => {
        throw new Error("measure fail");
      })
    ).rejects.toThrow("measure fail");

    client.destroy();
  });
});

describe("LunorClient — middleware", () => {
  it("use() registers middleware and returns this (chainable)", () => {
    const client = makeClient();
    const result = client.use((_p, next) => { next(); });
    expect(result).toBe(client);
    client.destroy();
  });

  it("middleware that does not call next drops the event", async () => {
    const client = makeClient();
    client.use((_p, _next) => { /* drop */ });
    client.log("dropped");
    // give async pipeline a tick to resolve
    await new Promise((r) => setTimeout(r, 0));
    expect(client.getStats().totalEvents).toBe(0);
    client.destroy();
  });
});

describe("LunorClient — context / tags / user", () => {
  it("setContext merges context", () => {
    const client = makeClient();
    client.setContext({ version: "1.0" });
    // Just verify no throw
    client.destroy();
  });

  it("setTag sets a tag", () => {
    const client = makeClient();
    client.setTag("env", "test");
    client.destroy();
  });

  it("setUser sets user in context", () => {
    const client = makeClient();
    client.setUser({ id: "u1", email: "a@b.com" });
    client.destroy();
  });
});

describe("LunorClient — forceFlush / destroy", () => {
  it("forceFlush resolves without throwing when queue is empty", async () => {
    const client = makeClient();
    await expect(client.forceFlush()).resolves.toBeUndefined();
    client.destroy();
  });

  it("destroy resolves and reports destroyed state", async () => {
    const client = makeClient();
    global.fetch = makeFetch();

    await client.destroy();

    expect(client.getStats().state).toBe("destroyed");
  });

  it("events are dropped after destroy", async () => {
    const client = makeClient();
    await client.destroy();
    client.log("after destroy");
    expect(client.getStats().totalEvents).toBe(0);
  });
});

describe("LunorClient — sampling", () => {
  it("drops all events when sampleRate is 0", () => {
    const client = makeClient({ sampleRate: 0 });
    for (let i = 0; i < 10; i++) client.log("msg");
    expect(client.getStats().totalEvents).toBe(0);
    client.destroy();
  });

  it("sends all events when sampleRate is 1", () => {
    const client = makeClient({ sampleRate: 1 });
    for (let i = 0; i < 5; i++) client.log("msg");
    expect(client.getStats().totalEvents).toBe(5);
    client.destroy();
  });
});

describe("LunorClient — flush behavior", () => {
  it("calls onFlushSuccess when events are sent successfully", async () => {
    const onFlushSuccess = vi.fn();
    global.fetch = makeFetch();

    const client = makeClient({ onFlushSuccess });
    client.log("msg");
    await client.forceFlush();
    // Give async flush a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(onFlushSuccess).toHaveBeenCalledWith(expect.any(Number));
    client.destroy();
  });

  it("requeues retriable failed items and calls onFlushError for dropped items", async () => {
    const onFlushError = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    });

    // maxRetries: 0 so the item is dropped immediately after first failure
    const client = makeClient({ onFlushError, maxRetries: 0 });
    client.log("msg");
    await client.forceFlush();
    await new Promise((r) => setTimeout(r, 10));

    expect(onFlushError).toHaveBeenCalled();
    client.destroy();
  });

  it("calls onFlushError on catastrophic fetch failure", async () => {
    const onFlushError = vi.fn();
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    const client = makeClient({ onFlushError, maxRetries: 0 });
    client.log("msg");
    await client.forceFlush();
    await new Promise((r) => setTimeout(r, 10));

    expect(onFlushError).toHaveBeenCalled();
    client.destroy();
  });

  it("auto-flushes when batchSize is reached", async () => {
    global.fetch = makeFetch();
    const client = makeClient({ batchSize: 2 });

    client.log("msg1");
    client.log("msg2"); // triggers auto-flush
    await new Promise((r) => setTimeout(r, 50));

    expect(client.getStats().totalEvents).toBe(2);
    client.destroy();
  });
});

describe("LunorClient — beforeSend hook", () => {
  it("drops event when beforeSend returns false", async () => {
    const client = makeClient({ beforeSend: async () => false });
    client.log("msg");
    await new Promise((r) => setTimeout(r, 0));
    expect(client.getStats().totalEvents).toBe(0);
    client.destroy();
  });

  it("allows event through when beforeSend returns the payload", async () => {
    const client = makeClient({
      beforeSend: async (p: unknown) => p,
    });
    client.log("msg");
    await new Promise((r) => setTimeout(r, 0));
    expect(client.getStats().totalEvents).toBe(1);
    client.destroy();
  });
});
