var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/types.ts
var LogLevel = /* @__PURE__ */ ((LogLevel2) => {
  LogLevel2["DEBUG"] = "DEBUG";
  LogLevel2["INFO"] = "INFO";
  LogLevel2["WARN"] = "WARN";
  LogLevel2["ERROR"] = "ERROR";
  LogLevel2["FATAL"] = "FATAL";
  return LogLevel2;
})(LogLevel || {});
var ErrorType = /* @__PURE__ */ ((ErrorType2) => {
  ErrorType2["RUNTIME"] = "RUNTIME";
  ErrorType2["SYNTAX"] = "SYNTAX";
  ErrorType2["NETWORK"] = "NETWORK";
  ErrorType2["DATABASE"] = "DATABASE";
  ErrorType2["AUTHENTICATION"] = "AUTHENTICATION";
  ErrorType2["AUTHORIZATION"] = "AUTHORIZATION";
  ErrorType2["VALIDATION"] = "VALIDATION";
  ErrorType2["TIMEOUT"] = "TIMEOUT";
  ErrorType2["MEMORY"] = "MEMORY";
  ErrorType2["UNKNOWN"] = "UNKNOWN";
  return ErrorType2;
})(ErrorType || {});
var Severity = /* @__PURE__ */ ((Severity2) => {
  Severity2["LOW"] = "LOW";
  Severity2["MEDIUM"] = "MEDIUM";
  Severity2["HIGH"] = "HIGH";
  Severity2["CRITICAL"] = "CRITICAL";
  return Severity2;
})(Severity || {});
var SecurityType = /* @__PURE__ */ ((SecurityType2) => {
  SecurityType2["BRUTE_FORCE"] = "BRUTE_FORCE";
  SecurityType2["UNAUTHORIZED_ACCESS"] = "UNAUTHORIZED_ACCESS";
  SecurityType2["SUSPICIOUS_ACTIVITY"] = "SUSPICIOUS_ACTIVITY";
  SecurityType2["DATA_BREACH"] = "DATA_BREACH";
  SecurityType2["INJECTION_ATTEMPT"] = "INJECTION_ATTEMPT";
  SecurityType2["XSS_ATTEMPT"] = "XSS_ATTEMPT";
  SecurityType2["CSRF_ATTEMPT"] = "CSRF_ATTEMPT";
  SecurityType2["RATE_LIMIT_EXCEEDED"] = "RATE_LIMIT_EXCEEDED";
  SecurityType2["INVALID_TOKEN"] = "INVALID_TOKEN";
  SecurityType2["IP_BLACKLISTED"] = "IP_BLACKLISTED";
  return SecurityType2;
})(SecurityType || {});

// src/constants.ts
var SDK_VERSION = "2.0.0";
var SDK_NAME = "lunor-sdk";
var LUNOR_ENDPOINT = "https://www.lunor.com.pl/api/webhook";
var DEFAULT_CONFIG = {
  // Endpoint jest stały — zawsze Twój serwer
  endpoint: LUNOR_ENDPOINT,
  batchSize: 10,
  flushInterval: 5e3,
  maxRetries: 3,
  retryBaseDelay: 1e3,
  retryMaxDelay: 3e4,
  timeout: 1e4,
  captureGlobalErrors: true,
  captureUnhandledRejections: true,
  captureConsole: false,
  captureConsoleLevels: ["error", "warn"],
  enablePersistence: true,
  persistencePrefix: "__lunor_",
  maxQueueSize: 1e3,
  minLogLevel: "DEBUG" /* DEBUG */,
  debug: false,
  defaultSource: "app",
  environment: "production",
  sampleRate: 1,
  enablePerformance: false
};
var LOG_LEVEL_PRIORITY = {
  ["DEBUG" /* DEBUG */]: 0,
  ["INFO" /* INFO */]: 1,
  ["WARN" /* WARN */]: 2,
  ["ERROR" /* ERROR */]: 3,
  ["FATAL" /* FATAL */]: 4
};
var HEADER_API_KEY = "X-API-Key";
var HEADER_API_SECRET = "X-API-Secret";

// src/utils.ts
function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}
function nowISO() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function safeStringify(obj, maxDepth = 10) {
  const seen = /* @__PURE__ */ new WeakSet();
  let depth = 0;
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value) || depth > maxDepth) return "[Circular]";
      seen.add(value);
      depth++;
    }
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    }
    return value;
  });
}
function safeParse(json, fallback) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}
function createInternalLogger(debug) {
  const prefix = `[${SDK_NAME}]`;
  return {
    debug: (...args) => {
      if (debug) console.debug(prefix, ...args);
    },
    info: (...args) => {
      if (debug) console.info(prefix, ...args);
    },
    warn: (...args) => {
      console.warn(prefix, ...args);
    },
    error: (...args) => {
      console.error(prefix, ...args);
    }
  };
}
function detectRuntime() {
  if (typeof window !== "undefined" && typeof document !== "undefined")
    return "browser";
  if (typeof process !== "undefined" && process.versions?.node) return "node";
  if (typeof globalThis !== "undefined" && typeof globalThis.EdgeRuntime === "string")
    return "edge";
  return "unknown";
}
function isBrowser() {
  return detectRuntime() === "browser";
}
function isNode() {
  return detectRuntime() === "node";
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function extractStack(error) {
  return error.stack || `${error.name}: ${error.message}`;
}
function truncate(str, maxLength = 1e4) {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + `... [truncated, total ${str.length} chars]`;
}

// src/retry.ts
async function withRetry(fn, options) {
  let lastError = null;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < options.maxRetries) {
        const delay = calculateBackoff(
          attempt,
          options.baseDelay,
          options.maxDelay
        );
        options.onRetry?.(attempt + 1, lastError);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}
function calculateBackoff(attempt, baseDelay, maxDelay) {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelay;
  return Math.min(exponentialDelay + jitter, maxDelay);
}

// src/transport.ts
var Transport = class {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }
  /**
   * Send a single payload to the webhook endpoint
   */
  async send(payload) {
    return withRetry(() => this.doSend(payload), {
      maxRetries: this.config.maxRetries ?? 3,
      baseDelay: this.config.retryBaseDelay ?? 1e3,
      maxDelay: this.config.retryMaxDelay ?? 3e4,
      onRetry: (attempt, error) => {
        this.logger.warn(
          `Retry attempt ${attempt} for ${payload.type}: ${error.message}`
        );
      }
    });
  }
  /**
   * Send a batch of payloads
   */
  async sendBatch(payloads) {
    const results = [];
    const concurrencyLimit = 5;
    for (let i = 0; i < payloads.length; i += concurrencyLimit) {
      const chunk = payloads.slice(i, i + concurrencyLimit);
      const chunkResults = await Promise.allSettled(
        chunk.map((payload) => this.send(payload))
      );
      for (const result of chunkResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            success: false,
            error: result.reason?.message || "Unknown error"
          });
        }
      }
    }
    return results;
  }
  async doSend(payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeout ?? 1e4
    );
    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [HEADER_API_KEY]: this.config.apiKey,
          [HEADER_API_SECRET]: this.config.apiSecret
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const body = await response.text().catch(() => "No body");
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          const error = new Error(`HTTP ${response.status}: ${body}`);
          error.noRetry = true;
          throw error;
        }
        throw new Error(`HTTP ${response.status}: ${body}`);
      }
      const json = await response.json();
      return {
        success: true,
        id: json.id,
        type: json.type
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.noRetry) {
        this.logger.error(`Non-retryable error: ${error.message}`);
        return {
          success: false,
          error: error.message
        };
      }
      throw error;
    }
  }
};

// src/queue.ts
var PersistentQueue = class {
  constructor(maxSize, storageKey, enablePersistence, logger) {
    this.items = [];
    this.maxSize = maxSize;
    this.storageKey = storageKey;
    this.enablePersistence = enablePersistence;
    this.logger = logger;
    this.restore();
  }
  /**
   * Add an item to the queue
   */
  enqueue(payload) {
    if (this.items.length >= this.maxSize) {
      const dropped = this.items.shift();
      this.logger.warn(
        `Queue full (${this.maxSize}), dropping oldest item: ${dropped?.id}`
      );
    }
    const item = {
      id: generateId(),
      payload,
      retries: 0,
      createdAt: Date.now()
    };
    this.items.push(item);
    this.persist();
  }
  /**
   * Take up to `count` items from the front of the queue
   */
  dequeue(count) {
    const taken = this.items.splice(0, count);
    this.persist();
    return taken;
  }
  /**
   * Return items to the front of the queue (for retry)
   */
  requeue(items) {
    const updatedItems = items.map((item) => ({
      ...item,
      retries: item.retries + 1,
      lastAttempt: Date.now()
    }));
    this.items.unshift(...updatedItems);
    if (this.items.length > this.maxSize) {
      this.items = this.items.slice(0, this.maxSize);
    }
    this.persist();
  }
  /**
   * Get current queue size
   */
  get size() {
    return this.items.length;
  }
  /**
   * Check if queue is empty
   */
  get isEmpty() {
    return this.items.length === 0;
  }
  /**
   * Get all items (without removing)
   */
  peek() {
    return [...this.items];
  }
  /**
   * Clear the queue
   */
  clear() {
    this.items = [];
    this.persist();
  }
  /**
   * Drain the entire queue
   */
  drain() {
    const all = [...this.items];
    this.items = [];
    this.persist();
    return all;
  }
  /**
   * Persist queue to storage
   */
  persist() {
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
  restore() {
    if (!this.enablePersistence) return;
    try {
      if (typeof localStorage !== "undefined") {
        const stored = localStorage.getItem(this.storageKey);
        if (stored) {
          const parsed = safeParse(stored, []);
          this.items = parsed.filter(
            // Only restore items less than 24h old
            (item) => Date.now() - item.createdAt < 24 * 60 * 60 * 1e3
          );
          if (this.items.length > 0) {
            this.logger.info(
              `Restored ${this.items.length} items from persistence`
            );
          }
        }
      }
    } catch (error) {
      this.logger.debug("Failed to restore queue:", error);
    }
  }
};

// src/middleware.ts
var MiddlewareChain = class {
  constructor() {
    this.middlewares = [];
  }
  /**
   * Add a middleware function
   */
  use(fn) {
    this.middlewares.push(fn);
  }
  /**
   * Execute the middleware chain on a payload.
   * Each middleware can modify the payload or stop the chain.
   * Returns the (possibly modified) payload, or null if dropped.
   */
  async execute(payload) {
    let currentPayload = payload;
    let dropped = false;
    for (const middleware of this.middlewares) {
      if (dropped) break;
      let nextCalled = false;
      await middleware(currentPayload, () => {
        nextCalled = true;
      });
      if (!nextCalled) {
        dropped = true;
      }
    }
    return dropped ? null : currentPayload;
  }
  /**
   * Get the number of registered middlewares
   */
  get count() {
    return this.middlewares.length;
  }
  /**
   * Clear all middlewares
   */
  clear() {
    this.middlewares = [];
  }
};

// src/context.ts
function collectContext(config) {
  const runtime = detectRuntime();
  const context = {
    environment: config.environment,
    release: config.release,
    tags: config.tags,
    runtime
  };
  if (isBrowser()) {
    collectBrowserContext(context);
  }
  if (isNode()) {
    collectNodeContext(context);
  }
  return context;
}
function collectBrowserContext(context) {
  try {
    context.userAgent = navigator.userAgent;
    context.url = window.location.href;
    context.locale = navigator.language;
    context.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (window.screen) {
      context.screenResolution = `${window.screen.width}x${window.screen.height}`;
    }
    context.os = extractOSFromUA(navigator.userAgent);
  } catch {
  }
}
function collectNodeContext(context) {
  try {
    const os = __require("os");
    context.hostname = os.hostname();
    context.os = `${os.platform()} ${os.release()}`;
    context.nodeVersion = process.version;
    context.pid = process.pid;
    const mem = process.memoryUsage();
    context.memoryUsage = {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024)
    };
  } catch {
  }
}
function extractOSFromUA(ua) {
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Mac OS")) return "macOS";
  if (ua.includes("Linux")) return "Linux";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("iOS") || ua.includes("iPhone") || ua.includes("iPad"))
    return "iOS";
  return "Unknown";
}

// src/global-handlers.ts
function installGlobalHandlers(client, options) {
  const cleanups = [];
  if (options.captureErrors) {
    cleanups.push(installErrorHandler(client));
  }
  if (options.captureRejections) {
    cleanups.push(installRejectionHandler(client));
  }
  if (options.captureConsole) {
    cleanups.push(installConsoleCapture(client, options.consoleLevels));
  }
  return {
    uninstall: () => {
      cleanups.forEach((cleanup) => cleanup());
    }
  };
}
function installErrorHandler(client) {
  if (isBrowser()) {
    const handler = (event) => {
      client.captureError({
        type: "RUNTIME" /* RUNTIME */,
        message: event.message || "Uncaught error",
        stack: event.error?.stack || `${event.filename}:${event.lineno}:${event.colno}`,
        severity: "HIGH" /* HIGH */,
        metadata: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          autoCapture: true
        }
      });
    };
    window.addEventListener("error", handler);
    return () => window.removeEventListener("error", handler);
  }
  if (isNode()) {
    const handler = (error) => {
      client.captureError({
        type: "RUNTIME" /* RUNTIME */,
        message: error.message || "Uncaught exception",
        stack: error.stack,
        severity: "CRITICAL" /* CRITICAL */,
        metadata: {
          name: error.name,
          autoCapture: true
        }
      });
      client.forceFlush().finally(() => {
        process.exit(1);
      });
    };
    process.on("uncaughtException", handler);
    return () => process.removeListener("uncaughtException", handler);
  }
  return () => {
  };
}
function installRejectionHandler(client) {
  if (isBrowser()) {
    const handler = (event) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason ?? "Unhandled rejection");
      const stack = reason instanceof Error ? reason.stack : void 0;
      client.captureError({
        type: "RUNTIME" /* RUNTIME */,
        message: `Unhandled Promise Rejection: ${message}`,
        stack,
        severity: "HIGH" /* HIGH */,
        metadata: { autoCapture: true, type: "unhandledRejection" }
      });
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }
  if (isNode()) {
    const handler = (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason ?? "Unhandled rejection");
      const stack = reason instanceof Error ? reason.stack : void 0;
      client.captureError({
        type: "RUNTIME" /* RUNTIME */,
        message: `Unhandled Promise Rejection: ${message}`,
        stack,
        severity: "HIGH" /* HIGH */,
        metadata: { autoCapture: true, type: "unhandledRejection" }
      });
    };
    process.on("unhandledRejection", handler);
    return () => process.removeListener("unhandledRejection", handler);
  }
  return () => {
  };
}
function installConsoleCapture(client, levels) {
  const originalMethods = {};
  const levelMap = {
    error: "ERROR" /* ERROR */,
    warn: "WARN" /* WARN */,
    log: "INFO" /* INFO */,
    debug: "DEBUG" /* DEBUG */
  };
  for (const level of levels) {
    if (level in console) {
      const original = console[level];
      originalMethods[level] = original;
      console[level] = (...args) => {
        original.apply(console, args);
        const message = args.map(
          (arg) => typeof arg === "object" ? JSON.stringify(arg) : String(arg)
        ).join(" ");
        client.log({
          level: levelMap[level] || "INFO" /* INFO */,
          message,
          metadata: { autoCapture: true, consoleLevel: level }
        });
      };
    }
  }
  return () => {
    for (const [level, original] of Object.entries(originalMethods)) {
      console[level] = original;
    }
  };
}

// src/client.ts
var LunorClient = class {
  constructor(config) {
    this.flushTimer = null;
    this.globalHandlersCleanup = null;
    this.performanceMarks = /* @__PURE__ */ new Map();
    this._state = "idle";
    this._eventCount = 0;
    this._flushCount = 0;
    this._errorCount = 0;
    if (!config.apiKey || !config.apiSecret) {
      throw new Error("[Lunor] apiKey and apiSecret are required");
    }
    this.config = {
      ...DEFAULT_CONFIG,
      ...config
    };
    if (config.endpoint && config.endpoint !== LUNOR_ENDPOINT && this.config.environment === "production") {
      console.warn(
        "[Lunor] Custom endpoint is not allowed in production. Using default."
      );
      this.config.endpoint = LUNOR_ENDPOINT;
    }
    this.logger = createInternalLogger(this.config.debug);
    this.transport = new Transport(this.config, this.logger);
    this.middlewareChain = new MiddlewareChain();
    this.queue = new PersistentQueue(
      this.config.maxQueueSize,
      `${this.config.persistencePrefix}queue`,
      this.config.enablePersistence,
      this.logger
    );
    this._state = "initializing";
    this.logger.info(`Lunor SDK v${SDK_VERSION} initializing...`);
    this.globalHandlersCleanup = installGlobalHandlers(this, {
      captureErrors: this.config.captureGlobalErrors,
      captureRejections: this.config.captureUnhandledRejections,
      captureConsole: this.config.captureConsole,
      consoleLevels: this.config.captureConsoleLevels
    });
    this.startFlushTimer();
    this.installShutdownHandler();
    this._state = "ready";
    this.logger.info("Lunor SDK ready");
    this.config.onReady?.();
  }
  // ==========================================================================
  // PUBLIC API — Logging
  // ==========================================================================
  /**
   * Send a log event
   */
  log(data) {
    const payload = typeof data === "string" ? { level: "INFO" /* INFO */, message: data } : data;
    if (!this.shouldSendLogLevel(payload.level || "INFO" /* INFO */)) return;
    this.enqueue({
      type: "log",
      data: {
        ...payload,
        level: payload.level || "INFO" /* INFO */,
        source: payload.source || this.config.defaultSource,
        timestamp: payload.timestamp || nowISO()
      }
    });
  }
  /** Shortcut: DEBUG level log */
  debug(message, metadata) {
    this.log({ level: "DEBUG" /* DEBUG */, message, metadata });
  }
  /** Shortcut: INFO level log */
  info(message, metadata) {
    this.log({ level: "INFO" /* INFO */, message, metadata });
  }
  /** Shortcut: WARN level log */
  warn(message, metadata) {
    this.log({ level: "WARN" /* WARN */, message, metadata });
  }
  /** Shortcut: ERROR level log (as log, not error event) */
  errorLog(message, metadata) {
    this.log({ level: "ERROR" /* ERROR */, message, metadata });
  }
  /** Shortcut: FATAL level log — immediately flushes */
  fatal(message, metadata) {
    this.log({ level: "FATAL" /* FATAL */, message, metadata });
    this.flush();
  }
  // ==========================================================================
  // PUBLIC API — Errors
  // ==========================================================================
  /**
   * Capture an error event
   */
  captureError(data) {
    let payload;
    if (typeof data === "string") {
      payload = { message: data, severity: "MEDIUM" /* MEDIUM */ };
    } else if (data instanceof Error) {
      payload = {
        type: "RUNTIME" /* RUNTIME */,
        message: data.message,
        stack: extractStack(data),
        severity: "MEDIUM" /* MEDIUM */,
        metadata: { name: data.name }
      };
    } else {
      payload = data;
    }
    const finalPayload = {
      ...payload,
      type: payload.type || "UNKNOWN" /* UNKNOWN */,
      severity: payload.severity || "MEDIUM" /* MEDIUM */,
      message: truncate(payload.message),
      stack: payload.stack ? truncate(payload.stack) : void 0,
      timestamp: payload.timestamp || nowISO()
    };
    this.enqueue({ type: "error", data: finalPayload });
    if (finalPayload.severity === "CRITICAL" /* CRITICAL */) {
      this.flush();
    }
  }
  /**
   * Shortcut: capture an Error object
   */
  captureException(error, extra) {
    this.captureError({
      type: "RUNTIME" /* RUNTIME */,
      message: error.message,
      stack: extractStack(error),
      severity: extra?.severity || "MEDIUM" /* MEDIUM */,
      metadata: {
        name: error.name,
        ...extra?.metadata
      }
    });
  }
  // ==========================================================================
  // PUBLIC API — Debug
  // ==========================================================================
  /**
   * Send a debug/diagnostic event
   */
  captureDebug(data) {
    this.enqueue({
      type: "debug",
      data: {
        ...data,
        type: data.type || "unknown",
        timestamp: data.timestamp || nowISO()
      }
    });
  }
  // ==========================================================================
  // PUBLIC API — Security
  // ==========================================================================
  /**
   * Report a security event
   */
  captureSecurityEvent(data) {
    this.enqueue({
      type: "security",
      data: {
        ...data,
        type: data.type || "SUSPICIOUS_ACTIVITY" /* SUSPICIOUS_ACTIVITY */
      }
    });
    this.flush();
  }
  // ==========================================================================
  // PUBLIC API — Performance
  // ==========================================================================
  /**
   * Start a performance measurement
   */
  startTimer(name, metadata) {
    this.performanceMarks.set(name, {
      name,
      startTime: performance.now(),
      metadata
    });
  }
  /**
   * Stop a performance measurement and optionally send as debug event
   */
  stopTimer(name, sendAsDebug = true) {
    const mark = this.performanceMarks.get(name);
    if (!mark) {
      this.logger.warn(`Performance mark "${name}" not found`);
      return null;
    }
    mark.endTime = performance.now();
    mark.duration = mark.endTime - mark.startTime;
    this.performanceMarks.delete(name);
    if (sendAsDebug) {
      this.captureDebug({
        type: "performance",
        data: { name: mark.name, ...mark.metadata },
        performance: {
          duration: Math.round(mark.duration * 100) / 100,
          startTime: mark.startTime,
          endTime: mark.endTime
        }
      });
    }
    return mark;
  }
  /**
   * Measure an async function's execution time
   */
  async measure(name, fn, metadata) {
    this.startTimer(name, metadata);
    try {
      const result = await fn();
      this.stopTimer(name);
      return result;
    } catch (error) {
      const mark = this.stopTimer(name, false);
      this.captureError({
        type: "RUNTIME" /* RUNTIME */,
        message: `Performance measurement "${name}" failed: ${error.message}`,
        stack: error.stack,
        severity: "MEDIUM" /* MEDIUM */,
        metadata: {
          ...metadata,
          duration: mark?.duration
        }
      });
      throw error;
    }
  }
  // ==========================================================================
  // PUBLIC API — Middleware
  // ==========================================================================
  /**
   * Add a middleware that processes events before they're queued
   */
  use(middleware) {
    this.middlewareChain.use(middleware);
    return this;
  }
  // ==========================================================================
  // PUBLIC API — Context
  // ==========================================================================
  /**
   * Update global context (merged with existing)
   */
  setContext(context) {
    this.config.globalContext = {
      ...this.config.globalContext || {},
      ...context
    };
  }
  /**
   * Set a tag
   */
  setTag(key, value) {
    if (!this.config.tags) this.config.tags = {};
    this.config.tags[key] = value;
  }
  /**
   * Set the user context
   */
  setUser(user) {
    this.setContext({ user });
  }
  // ==========================================================================
  // PUBLIC API — Flush & Lifecycle
  // ==========================================================================
  /**
   * Force an immediate flush of the queue
   */
  async forceFlush() {
    await this.flush();
  }
  /**
   * Get SDK stats
   */
  getStats() {
    return {
      state: this._state,
      queueSize: this.queue.size,
      totalEvents: this._eventCount,
      totalFlushes: this._flushCount,
      totalErrors: this._errorCount,
      sdkVersion: SDK_VERSION
    };
  }
  /**
   * Destroy the SDK instance — flushes remaining events and cleans up
   */
  async destroy() {
    this.logger.info("Destroying Lunor SDK...");
    this._state = "destroyed";
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.globalHandlersCleanup?.uninstall();
    await this.flush();
    this.logger.info("Lunor SDK destroyed");
  }
  // ==========================================================================
  // INTERNAL METHODS
  // ==========================================================================
  shouldSendLogLevel(level) {
    const minPriority = LOG_LEVEL_PRIORITY[this.config.minLogLevel] ?? 0;
    const currentPriority = LOG_LEVEL_PRIORITY[level] ?? 0;
    return currentPriority >= minPriority;
  }
  shouldSample() {
    if (this.config.sampleRate >= 1) return true;
    if (this.config.sampleRate <= 0) return false;
    return Math.random() < this.config.sampleRate;
  }
  async enqueue(payload) {
    if (this._state === "destroyed") {
      this.logger.warn("SDK destroyed, dropping event");
      return;
    }
    if (!this.shouldSample()) {
      this.logger.debug("Event dropped by sampling");
      return;
    }
    payload._meta = {
      sdkVersion: SDK_VERSION,
      timestamp: nowISO(),
      context: {
        ...collectContext(this.config),
        ...this.config.globalContext ? {
          tags: {
            ...this.config.tags || {},
            ...this.config.globalContext
          }
        } : {}
      }
    };
    if (this.config.beforeSend) {
      try {
        const result = await this.config.beforeSend(payload);
        if (result === false) {
          this.logger.debug("Event dropped by beforeSend hook");
          return;
        }
        payload = result;
      } catch (error) {
        this.logger.error("beforeSend hook error:", error);
      }
    }
    if (this.middlewareChain.count > 0) {
      const processed = await this.middlewareChain.execute(payload);
      if (!processed) {
        this.logger.debug("Event dropped by middleware");
        return;
      }
      payload = processed;
    }
    this.queue.enqueue(payload);
    this._eventCount++;
    this.logger.debug(
      `Queued ${payload.type} event (queue: ${this.queue.size})`
    );
    if (this.queue.size >= this.config.batchSize) {
      this.flush();
    }
  }
  async flush() {
    if (this.queue.isEmpty) return;
    if (this._state === "flushing") return;
    const previousState = this._state;
    this._state = "flushing";
    const items = this.queue.dequeue(this.config.batchSize);
    const payloads = items.map((item) => item.payload);
    this.logger.debug(`Flushing ${payloads.length} events...`);
    try {
      const results = await this.transport.sendBatch(payloads);
      const failedItems = items.filter((_, index) => !results[index]?.success);
      if (failedItems.length > 0) {
        const retriable = failedItems.filter(
          (item) => item.retries < this.config.maxRetries
        );
        const dropped = failedItems.filter(
          (item) => item.retries >= this.config.maxRetries
        );
        if (retriable.length > 0) {
          this.queue.requeue(retriable);
          this.logger.warn(`${retriable.length} events requeued for retry`);
        }
        if (dropped.length > 0) {
          this._errorCount += dropped.length;
          this.logger.error(
            `${dropped.length} events permanently dropped after max retries`
          );
          this.config.onFlushError?.(
            new Error(`${dropped.length} events failed`),
            dropped.map((i) => i.payload)
          );
        }
      }
      const successCount = payloads.length - failedItems.length;
      if (successCount > 0) {
        this._flushCount++;
        this.config.onFlushSuccess?.(successCount);
        this.logger.debug(`Successfully flushed ${successCount} events`);
      }
    } catch (error) {
      this.queue.requeue(items);
      this._errorCount++;
      this.logger.error("Flush failed catastrophically:", error);
      this.config.onFlushError?.(
        error instanceof Error ? error : new Error(String(error)),
        payloads
      );
    } finally {
      this._state = previousState === "destroyed" ? "destroyed" : "ready";
    }
  }
  startFlushTimer() {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.config.flushInterval);
  }
  installShutdownHandler() {
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        this.sendBeaconFlush();
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          this.sendBeaconFlush();
        }
      });
    }
    if (typeof process !== "undefined" && process.on) {
      const handler = () => {
        this.flush();
      };
      process.on("beforeExit", handler);
      process.on("SIGINT", async () => {
        await this.destroy();
        process.exit(0);
      });
      process.on("SIGTERM", async () => {
        await this.destroy();
        process.exit(0);
      });
    }
  }
  /**
   * Use navigator.sendBeacon for last-chance delivery (browser only)
   */
  sendBeaconFlush() {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
    const items = this.queue.drain();
    if (items.length === 0) return;
    for (const item of items) {
      try {
        const blob = new Blob([JSON.stringify(item.payload)], {
          type: "application/json"
        });
        const enrichedPayload = {
          ...item.payload,
          _auth: {
            apiKey: this.config.apiKey,
            apiSecret: this.config.apiSecret
          }
        };
        navigator.sendBeacon(
          this.config.endpoint,
          new Blob([JSON.stringify(enrichedPayload)], {
            type: "application/json"
          })
        );
      } catch {
      }
    }
  }
};

// src/index.ts
var _instance = null;
function createLunorClient(config) {
  return new LunorClient(config);
}
function init(config) {
  if (_instance) {
    console.warn(
      "[Lunor] SDK already initialized. Call destroy() first to re-initialize."
    );
    return _instance;
  }
  _instance = new LunorClient(config);
  return _instance;
}
function getInstance() {
  if (!_instance) {
    throw new Error("[Lunor] SDK not initialized. Call init() first.");
  }
  return _instance;
}
async function destroy() {
  if (_instance) {
    await _instance.destroy();
    _instance = null;
  }
}
var index_default = {
  init,
  getInstance,
  destroy,
  createLunorClient,
  LunorClient,
  LogLevel,
  ErrorType,
  Severity,
  SecurityType
};
export {
  ErrorType,
  LogLevel,
  LunorClient,
  SecurityType,
  Severity,
  createLunorClient,
  index_default as default,
  destroy,
  getInstance,
  init
};
//# sourceMappingURL=index.mjs.map