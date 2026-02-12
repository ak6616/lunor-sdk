import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LogVaultClient } from "../src/client";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

function createClient(overrides = {}) {
  return new LogVaultClient({
    apiKey: "test-key",
    apiSecret: "test-secret",
    endpoint: "https://test.logvault.io/api/webhook",
    debug: false,
    ...overrides,
  });
}

function mockSuccess(id = "mock-id") {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ success: true, id, type: "log" }),
  });
}

describe("LogVaultClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Initialization ----

  describe("initialization", () => {
    it("throws if apiKey is missing", () => {
      expect(() => createClient({ apiKey: "" })).toThrow("apiKey is required");
    });

    it("throws if apiSecret is missing", () => {
      expect(() => createClient({ apiSecret: "" })).toThrow(
        "apiSecret is required",
      );
    });

    it("throws if endpoint is missing", () => {
      expect(() => createClient({ endpoint: "" })).toThrow(
        "endpoint is required",
      );
    });

    it("creates client with valid config", () => {
      const client = createClient();
      expect(client).toBeInstanceOf(LogVaultClient);
    });
  });

  // ---- Logging ----

  describe("logging", () => {
    it("sends INFO log", async () => {
      const client = createClient();
      mockSuccess();

      const result = await client.info("Test message");

      expect(result?.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://test.logvault.io/api/webhook");

      const body = JSON.parse(options.body);
      expect(body.type).toBe("log");
      expect(body.data.level).toBe("INFO");
      expect(body.data.message).toBe("Test message");
    });

    it("sends correct headers", async () => {
      const client = createClient();
      mockSuccess();

      await client.info("Test");

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers["X-API-Key"]).toBe("test-key");
      expect(options.headers["X-API-Secret"]).toBe("test-secret");
      expect(options.headers["Content-Type"]).toBe("application/json");
    });

    it("respects minLevel — skips DEBUG when minLevel=INFO", async () => {
      const client = createClient({ minLevel: "INFO" });

      const result = await client.trace("Debug message");

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("includes metadata", async () => {
      const client = createClient();
      mockSuccess();

      await client.info("With meta", { userId: "123", action: "test" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.metadata.userId).toBe("123");
      expect(body.data.metadata.action).toBe("test");
    });

    it("includes source", async () => {
      const client = createClient({ defaultSource: "test-suite" });
      mockSuccess();

      await client.info("Test");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.source).toBe("test-suite");
    });

    it("sends all log levels", async () => {
      const client = createClient();

      const levels = [
        { fn: "trace", expected: "DEBUG" },
        { fn: "info", expected: "INFO" },
        { fn: "warn", expected: "WARN" },
        { fn: "error", expected: "ERROR" },
        { fn: "fatal", expected: "FATAL" },
      ] as const;

      for (const { fn, expected } of levels) {
        mockSuccess();
        await client[fn]("Test");
        const body = JSON.parse(mockFetch.mock.calls.at(-1)![1].body);
        expect(body.data.level).toBe(expected);
      }
    });
  });

  // ---- Error Tracking ----

  describe("error tracking", () => {
    it("captures Error object", async () => {
      const client = createClient();
      mockSuccess();

      const error = new TypeError('Cannot read property "x" of undefined');
      await client.captureException(error);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBe("error");
      expect(body.data.message).toBe('Cannot read property "x" of undefined');
      expect(body.data.type).toBe("TYPE");
      expect(body.data.stack).toBeTruthy();
    });

    it("captures string as error", async () => {
      const client = createClient();
      mockSuccess();

      await client.captureException("Something went wrong");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.message).toBe("Something went wrong");
    });

    it("sets severity", async () => {
      const client = createClient();
      mockSuccess();

      await client.captureException(new Error("Critical!"), {
        severity: "CRITICAL",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.severity).toBe("CRITICAL");
    });

    it("auto-classifies error types", async () => {
      const client = createClient();

      const cases = [
        { error: new TypeError("x"), expected: "TYPE" },
        { error: new ReferenceError("x"), expected: "REFERENCE" },
        { error: new SyntaxError("x"), expected: "SYNTAX" },
        { error: new Error("fetch failed"), expected: "NETWORK" },
        { error: new Error("Request timed out"), expected: "TIMEOUT" },
        { error: new Error("Unauthorized 401"), expected: "AUTHENTICATION" },
      ];

      for (const { error, expected } of cases) {
        mockSuccess();
        await client.captureException(error);
        const body = JSON.parse(mockFetch.mock.calls.at(-1)![1].body);
        expect(body.data.type).toBe(expected);
      }
    });

    it("generates fingerprint", async () => {
      const client = createClient();
      mockSuccess();

      await client.captureException(new Error("Test error"));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.metadata._fingerprint).toBeTruthy();
      expect(typeof body.data.metadata._fingerprint).toBe("string");
    });
  });

  // ---- Security ----

  describe("security", () => {
    it("sends security event", async () => {
      const client = createClient();
      mockSuccess();

      await client.security({
        type: "BRUTE_FORCE",
        description: "Too many login attempts",
        ipAddress: "192.168.1.1",
        userAgent: "curl/7.68",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBe("security");
      expect(body.data.type).toBe("BRUTE_FORCE");
      expect(body.data.description).toBe("Too many login attempts");
      expect(body.data.ipAddress).toBe("192.168.1.1");
    });
  });

  // ---- Debug ----

  describe("debug", () => {
    it("sends debug data", async () => {
      const client = createClient();
      mockSuccess();

      await client.debug({
        type: "performance",
        data: { queryTime: 150 },
        performance: { durationMs: 150 },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBe("debug");
      expect(body.data.type).toBe("performance");
    });
  });

  // ---- Sanitization ----

  describe("sanitization", () => {
    it("redacts sensitive fields", async () => {
      const client = createClient({ sanitize: true });
      mockSuccess();

      await client.info("User login", {
        email: "test@test.com",
        password: "super-secret-123",
        token: "jwt-token-xyz",
        name: "John",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.metadata.password).toBe("[REDACTED]");
      expect(body.data.metadata.token).toBe("[REDACTED]");
      expect(body.data.metadata.email).toBe("test@test.com");
      expect(body.data.metadata.name).toBe("John");
    });

    it("redacts custom sensitive fields", async () => {
      const client = createClient({
        sanitize: true,
        sensitiveFields: ["internalId"],
      });
      mockSuccess();

      await client.info("Test", { internalId: "12345", name: "visible" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.metadata.internalId).toBe("[REDACTED]");
      expect(body.data.metadata.name).toBe("visible");
    });
  });

  // ---- Context ----

  describe("context", () => {
    it("attaches global context to events", async () => {
      const client = createClient();
      mockSuccess();

      client.setUser("user-123", { plan: "pro" });
      await client.info("Test with context");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.metadata._userId).toBe("user-123");
      expect(body.data.metadata.plan).toBe("pro");
    });

    it("withScope adds scoped context", async () => {
      const client = createClient();
      mockSuccess();
      mockSuccess();

      await client.withScope(
        { requestId: "req-abc", tags: ["important"] },
        async () => {
          await client.info("Inside scope");
        },
      );

      await client.info("Outside scope");

      const insideBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const outsideBody = JSON.parse(mockFetch.mock.calls[1][1].body);

      expect(insideBody.data.metadata._requestId).toBe("req-abc");
      expect(outsideBody.data.metadata._requestId).toBeUndefined();
    });
  });

  // ---- beforeSend hook ----

  describe("beforeSend", () => {
    it("can drop events by returning false", async () => {
      const client = createClient({
        beforeSend: (event) => {
          if (
            (event.data as { message?: string }).message?.includes("ignore")
          ) {
            return false;
          }
          return event;
        },
      });

      const result = await client.info("Please ignore this");

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("can modify events", async () => {
      const client = createClient({
        beforeSend: (event) => {
          (event.data as Record<string, unknown>).message = "MODIFIED";
          return event;
        },
      });
      mockSuccess();

      await client.info("Original message");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.message).toBe("MODIFIED");
    });
  });

  // ---- Global Metadata ----

  describe("globalMetadata", () => {
    it("attaches global metadata to every event", async () => {
      const client = createClient({
        globalMetadata: { service: "api", version: "1.0" },
      });
      mockSuccess();

      await client.info("Test");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.metadata.service).toBe("api");
      expect(body.data.metadata.version).toBe("1.0");
    });
  });

  // ---- wrapAsync ----

  describe("wrapAsync", () => {
    it("captures thrown errors automatically", async () => {
      const client = createClient();
      mockSuccess();

      const wrapped = client.wrapAsync(async () => {
        throw new Error("Wrapped error");
      });

      await expect(wrapped()).rejects.toThrow("Wrapped error");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBe("error");
      expect(body.data.message).toBe("Wrapped error");
    });

    it("returns value on success", async () => {
      const client = createClient();

      const wrapped = client.wrapAsync(async () => {
        return 42;
      });

      const result = await wrapped();
      expect(result).toBe(42);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
