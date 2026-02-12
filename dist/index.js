'use strict';

// src/utils/retry.ts
async function withRetry(fn, options) {
  const { maxRetries, baseDelay, maxDelay = 3e4, onRetry } = options;
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error2) {
      lastError = error2 instanceof Error ? error2 : new Error(String(error2));
      if (attempt === maxRetries) break;
      const delay = Math.min(
        baseDelay * Math.pow(2, attempt) + Math.random() * 1e3,
        maxDelay
      );
      onRetry?.(attempt + 1, lastError);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// src/transports/http.ts
var HttpTransport = class {
  constructor(config) {
    this.config = {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      endpoint: config.endpoint.replace(/\/$/, ""),
      timeout: config.timeout ?? 1e4,
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1e3,
      debug: config.debug ?? false
    };
  }
  async send(payload) {
    return withRetry(() => this.doSend(payload), {
      maxRetries: this.config.maxRetries,
      baseDelay: this.config.retryDelay,
      onRetry: (attempt, error2) => {
        if (this.config.debug) {
          console.warn(
            `[LogVault] Retry ${attempt}/${this.config.maxRetries}: ${error2.message}`
          );
        }
      }
    });
  }
  async sendBatch(payloads) {
    const results = [];
    const concurrency = 5;
    for (let i = 0; i < payloads.length; i += concurrency) {
      const chunk = payloads.slice(i, i + concurrency);
      const chunkResults = await Promise.allSettled(
        chunk.map((p) => this.send(p))
      );
      for (const result of chunkResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            success: false,
            error: result.reason?.message ?? "Unknown error"
          });
        }
      }
    }
    return results;
  }
  async doSend(payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
    try {
      if (this.config.debug) {
        console.debug(
          `[LogVault] Sending ${payload.type}:`,
          JSON.stringify(payload.data).slice(0, 200)
        );
      }
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.config.apiKey,
          "X-API-Secret": this.config.apiSecret,
          "User-Agent": "LogVault-SDK/1.0.0"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.error || `HTTP ${response.status}: ${response.statusText}`
        );
      }
      return data;
    } catch (error2) {
      if (error2 instanceof DOMException && error2.name === "AbortError") {
        throw new Error(`Request timed out after ${this.config.timeout}ms`);
      }
      throw error2;
    } finally {
      clearTimeout(timeoutId);
    }
  }
};

// src/transports/batch.ts
var BatchTransport = class {
  constructor(config, http) {
    this.queue = [];
    this.timer = null;
    this.http = http;
    this.batchSize = config.batchSize ?? 50;
    this.batchInterval = config.batchInterval ?? 5e3;
    this.debug = config.debug ?? false;
    this.startTimer();
  }
  add(payload) {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      if (this.queue.length >= this.batchSize) {
        this.flush();
      }
    });
  }
  async flush() {
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
    } catch (error2) {
      const err = error2 instanceof Error ? error2 : new Error(String(error2));
      items.forEach((item) => item.reject(err));
    }
  }
  startTimer() {
    this.timer = setInterval(() => {
      this.flush();
    }, this.batchInterval);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }
  destroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }
  get pending() {
    return this.queue.length;
  }
};

// src/transports/offline-queue.ts
var OfflineQueue = class {
  constructor(config, http) {
    this.http = http;
    this.queue = [];
    this.processing = false;
    this.maxSize = config.maxOfflineQueueSize ?? 500;
    this.debug = config.debug ?? false;
  }
  enqueue(payload) {
    if (this.queue.length >= this.maxSize) {
      this.queue.shift();
      if (this.debug) {
        console.warn("[LogVault] Offline queue full \u2014 dropping oldest event");
      }
    }
    this.queue.push({
      payload,
      timestamp: Date.now(),
      retries: 0
    });
    if (this.debug) {
      console.debug(
        `[LogVault] Queued offline event (${this.queue.length} in queue)`
      );
    }
  }
  async drain() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    if (this.debug) {
      console.debug(
        `[LogVault] Draining offline queue (${this.queue.length} events)`
      );
    }
    while (this.queue.length > 0) {
      const event = this.queue[0];
      try {
        await this.http.send(event.payload);
        this.queue.shift();
      } catch {
        event.retries++;
        if (event.retries >= 3) {
          this.queue.shift();
          if (this.debug) {
            console.warn("[LogVault] Dropping event after max retries");
          }
        } else {
          break;
        }
      }
    }
    this.processing = false;
  }
  get size() {
    return this.queue.length;
  }
};

// src/context/context-manager.ts
var ContextManager = class {
  constructor() {
    this.globalContext = {};
    this.scopeStack = [];
  }
  setGlobalContext(ctx) {
    this.globalContext = { ...this.globalContext, ...ctx };
  }
  clearGlobalContext() {
    this.globalContext = {};
  }
  pushScope(ctx) {
    this.scopeStack.push(ctx);
  }
  popScope() {
    return this.scopeStack.pop();
  }
  getContext() {
    const merged = { ...this.globalContext };
    for (const scope of this.scopeStack) {
      Object.assign(merged, scope);
      if (scope.tags) {
        merged.tags = [...merged.tags || [], ...scope.tags];
      }
      if (scope.extra) {
        merged.extra = { ...merged.extra || {}, ...scope.extra };
      }
    }
    return merged;
  }
  getContextAsMetadata() {
    const ctx = this.getContext();
    const meta = {};
    if (ctx.userId) meta._userId = ctx.userId;
    if (ctx.sessionId) meta._sessionId = ctx.sessionId;
    if (ctx.requestId) meta._requestId = ctx.requestId;
    if (ctx.traceId) meta._traceId = ctx.traceId;
    if (ctx.tags && ctx.tags.length > 0) meta._tags = ctx.tags;
    if (ctx.extra) Object.assign(meta, ctx.extra);
    return meta;
  }
};

// src/utils/sanitizer.ts
var DEFAULT_SENSITIVE_FIELDS = [
  "password",
  "passwd",
  "secret",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiKey",
  "api_key",
  "apiSecret",
  "api_secret",
  "authorization",
  "cookie",
  "creditCard",
  "credit_card",
  "cardNumber",
  "card_number",
  "cvv",
  "ssn",
  "social_security",
  "privateKey",
  "private_key"
];
var Sanitizer = class {
  constructor(customFields = []) {
    this.sensitiveFields = /* @__PURE__ */ new Set([
      ...DEFAULT_SENSITIVE_FIELDS.map((f) => f.toLowerCase()),
      ...customFields.map((f) => f.toLowerCase())
    ]);
  }
  sanitize(data, depth = 0) {
    if (depth > 10) return "[MAX_DEPTH]";
    if (data === null || data === void 0) return data;
    if (typeof data === "string") return data;
    if (typeof data === "number" || typeof data === "boolean") return data;
    if (Array.isArray(data)) {
      return data.map((item) => this.sanitize(item, depth + 1));
    }
    if (typeof data === "object") {
      const sanitized = {};
      for (const [key, value] of Object.entries(data)) {
        if (this.sensitiveFields.has(key.toLowerCase())) {
          sanitized[key] = "[REDACTED]";
        } else {
          sanitized[key] = this.sanitize(value, depth + 1);
        }
      }
      return sanitized;
    }
    return String(data);
  }
  sanitizeMetadata(metadata) {
    if (!metadata) return metadata;
    return this.sanitize(metadata);
  }
};

// src/interceptors/performance.ts
var PerformanceMonitor = class {
  constructor(client) {
    this.client = client;
    this.entries = /* @__PURE__ */ new Map();
  }
  startTimer(name, metadata) {
    const entry = {
      name,
      startTime: Date.now(),
      metadata
    };
    this.entries.set(name, entry);
    return () => this.stopTimer(name);
  }
  stopTimer(name) {
    const entry = this.entries.get(name);
    if (!entry) return null;
    entry.endTime = Date.now();
    entry.duration = entry.endTime - entry.startTime;
    this.entries.delete(name);
    this.client.debug({
      type: "performance",
      data: {
        name: entry.name,
        duration: entry.duration,
        ...entry.metadata
      },
      performance: {
        startTime: entry.startTime,
        endTime: entry.endTime,
        durationMs: entry.duration
      }
    });
    return entry;
  }
  /**
   * Measure an async operation
   */
  async measure(name, fn, metadata) {
    const stop = this.startTimer(name, metadata);
    try {
      return await fn();
    } finally {
      stop();
    }
  }
  /**
   * Wrap a function with automatic performance tracking
   */
  wrap(name, fn) {
    const self = this;
    return function(...args) {
      const stop = self.startTimer(name, { argCount: args.length });
      try {
        const result = fn.apply(this, args);
        if (result instanceof Promise) {
          return result.finally(() => stop());
        }
        stop();
        return result;
      } catch (error2) {
        stop();
        throw error2;
      }
    };
  }
};

// src/interceptors/global-error.ts
function setupGlobalErrorHandler(client) {
  if (typeof process !== "undefined" && process.on) {
    const uncaughtHandler = (error2) => {
      client.captureException(error2, {
        severity: "CRITICAL",
        metadata: { handler: "uncaughtException" }
      });
    };
    const rejectionHandler = (reason) => {
      const error2 = reason instanceof Error ? reason : new Error(String(reason));
      client.captureException(error2, {
        severity: "HIGH",
        metadata: { handler: "unhandledRejection" }
      });
    };
    process.on("uncaughtException", uncaughtHandler);
    process.on("unhandledRejection", rejectionHandler);
    return () => {
      process.removeListener("uncaughtException", uncaughtHandler);
      process.removeListener("unhandledRejection", rejectionHandler);
    };
  }
  if (typeof window !== "undefined") {
    const errorHandler = (event) => {
      client.captureException(event.error || new Error(event.message), {
        severity: "HIGH",
        metadata: {
          handler: "window.onerror",
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno
        }
      });
    };
    const rejectionHandler = (event) => {
      const error2 = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
      client.captureException(error2, {
        severity: "HIGH",
        metadata: { handler: "unhandledrejection" }
      });
    };
    window.addEventListener("error", errorHandler);
    window.addEventListener("unhandledrejection", rejectionHandler);
    return () => {
      window.removeEventListener("error", errorHandler);
      window.removeEventListener("unhandledrejection", rejectionHandler);
    };
  }
  return () => {
  };
}

// src/interceptors/console.ts
var CONSOLE_LEVEL_MAP = {
  debug: "DEBUG",
  log: "INFO",
  info: "INFO",
  warn: "WARN",
  error: "ERROR"
};
function setupConsoleInterceptor(client) {
  const original = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
  };
  for (const [method, level] of Object.entries(CONSOLE_LEVEL_MAP)) {
    const originalFn = original[method];
    console[method] = (...args) => {
      originalFn.apply(console, args);
      const message = args.map((arg) => {
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }).join(" ");
      client.log(message, {
        level,
        source: "console",
        metadata: { method, argCount: args.length }
      });
    };
  }
  return () => {
    Object.assign(console, original);
  };
}

// src/utils/fingerprint.ts
function generateErrorFingerprint(message, stack, type) {
  const parts = [];
  if (type) parts.push(type);
  const cleanMessage = message.replace(/\b\d+\b/g, "<N>").replace(/['"][^'"]*['"]/g, "<S>").replace(/0x[0-9a-fA-F]+/g, "<HEX>").trim();
  parts.push(cleanMessage);
  if (stack) {
    const lines = stack.split("\n");
    const firstFrame = lines.find(
      (line) => line.includes("at ") && !line.includes("node_modules") && !line.includes("<anonymous>")
    );
    if (firstFrame) {
      const match = firstFrame.match(/at\s+(.+?)\s+\((.+?):(\d+):\d+\)/);
      if (match) {
        parts.push(`${match[1]}@${match[2]}:${match[3]}`);
      }
    }
  }
  return simpleHash(parts.join("|"));
}
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// src/client.ts
var LOG_LEVEL_PRIORITY = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};
var LogVaultClient = class {
  constructor(config) {
    this.batch = null;
    this.offlineQueue = null;
    this.cleanupFns = [];
    this._isOnline = true;
    this._initialized = false;
    this.validateConfig(config);
    this.config = {
      minLevel: "DEBUG",
      sanitize: true,
      enableBatching: false,
      batchInterval: 5e3,
      batchSize: 50,
      maxRetries: 3,
      retryDelay: 1e3,
      timeout: 1e4,
      enableOfflineQueue: false,
      maxOfflineQueueSize: 500,
      debug: false,
      ...config
    };
    this.http = new HttpTransport(this.config);
    this.contextManager = new ContextManager();
    this.sanitizer = new Sanitizer(this.config.sensitiveFields);
    this._performance = new PerformanceMonitor(this);
    if (this.config.enableBatching) {
      this.batch = new BatchTransport(this.config, this.http);
    }
    if (this.config.enableOfflineQueue) {
      this.offlineQueue = new OfflineQueue(this.config, this.http);
      this.setupConnectivityListeners();
    }
    if (this.config.captureGlobalErrors) {
      const cleanup = setupGlobalErrorHandler(this);
      this.cleanupFns.push(cleanup);
    }
    if (this.config.interceptConsole) {
      const cleanup = setupConsoleInterceptor(this);
      this.cleanupFns.push(cleanup);
    }
    if (this.config.environment || this.config.release) {
      this.contextManager.setGlobalContext({
        extra: {
          ...this.config.environment && {
            environment: this.config.environment
          },
          ...this.config.release && { release: this.config.release }
        }
      });
    }
    this._initialized = true;
    if (this.config.debug) {
      console.debug("[LogVault] SDK initialized", {
        endpoint: this.config.endpoint,
        batching: this.config.enableBatching,
        offlineQueue: this.config.enableOfflineQueue
      });
    }
  }
  // ============================================================
  // Public API — Logging
  // ============================================================
  /**
   * Send a log entry
   */
  async log(message, options = {}) {
    const level = options.level || "INFO";
    if (!this.shouldLog(level)) return null;
    const payload = {
      type: "log",
      data: {
        level,
        message,
        metadata: this.enrichMetadata(options.metadata),
        source: options.source || this.config.defaultSource,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      }
    };
    return this.send(payload);
  }
  /** Convenience: DEBUG level */
  async trace(message, metadata) {
    return this.log(message, { level: "DEBUG", metadata });
  }
  /** Convenience: INFO level */
  async info(message, metadata) {
    return this.log(message, { level: "INFO", metadata });
  }
  /** Convenience: WARN level */
  async warn(message, metadata) {
    return this.log(message, { level: "WARN", metadata });
  }
  /** Convenience: ERROR level */
  async error(message, metadata) {
    return this.log(message, { level: "ERROR", metadata });
  }
  /** Convenience: FATAL level */
  async fatal(message, metadata) {
    return this.log(message, { level: "FATAL", metadata });
  }
  // ============================================================
  // Public API — Error Tracking
  // ============================================================
  /**
   * Capture and report an error/exception
   */
  async captureException(error2, options = {}) {
    const err = typeof error2 === "string" ? new Error(error2) : error2;
    const errorType = options.type || this.classifyError(err);
    const severity = options.severity || "MEDIUM";
    const fingerprint = generateErrorFingerprint(
      err.message,
      err.stack,
      errorType
    );
    const payload = {
      type: "error",
      data: {
        type: errorType,
        message: err.message,
        stack: err.stack || null,
        severity,
        metadata: this.enrichMetadata({
          ...options.metadata,
          _fingerprint: fingerprint,
          _errorName: err.name
        }),
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      }
    };
    return this.send(payload);
  }
  /**
   * Wrap an async function with automatic error capturing
   */
  wrapAsync(fn, options) {
    const self = this;
    return async function(...args) {
      try {
        return await fn.apply(this, args);
      } catch (error2) {
        await self.captureException(
          error2 instanceof Error ? error2 : new Error(String(error2)),
          options
        );
        throw error2;
      }
    };
  }
  // ============================================================
  // Public API — Debug
  // ============================================================
  /**
   * Send debug/diagnostic data
   */
  async debug(options) {
    const payload = {
      type: "debug",
      data: {
        type: options.type || "debug",
        data: this.enrichMetadata(options.data),
        performance: options.performance,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      }
    };
    return this.send(payload);
  }
  // ============================================================
  // Public API — Security
  // ============================================================
  /**
   * Report a security event
   */
  async security(options) {
    const payload = {
      type: "security",
      data: {
        type: options.type || "SUSPICIOUS_ACTIVITY",
        description: options.description,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
        country: options.country,
        metadata: this.enrichMetadata(options.metadata)
      }
    };
    return this.send(payload);
  }
  // ============================================================
  // Public API — Context
  // ============================================================
  /**
   * Set global context (attached to every event)
   */
  setContext(ctx) {
    this.contextManager.setGlobalContext(ctx);
  }
  /**
   * Set user info
   */
  setUser(userId, extra) {
    this.contextManager.setGlobalContext({
      userId,
      extra
    });
  }
  /**
   * Start a scoped context (e.g., for a request)
   */
  pushScope(ctx) {
    this.contextManager.pushScope(ctx);
  }
  /**
   * End the current scope
   */
  popScope() {
    this.contextManager.popScope();
  }
  /**
   * Execute a function within a scoped context
   */
  async withScope(ctx, fn) {
    this.pushScope(ctx);
    try {
      return await fn();
    } finally {
      this.popScope();
    }
  }
  // ============================================================
  // Public API — Performance
  // ============================================================
  get performance() {
    return this._performance;
  }
  // ============================================================
  // Public API — Lifecycle
  // ============================================================
  /**
   * Flush all pending events
   */
  async flush() {
    if (this.batch) {
      await this.batch.flush();
    }
    if (this.offlineQueue && this._isOnline) {
      await this.offlineQueue.drain();
    }
  }
  /**
   * Destroy the client — flush and clean up
   */
  async destroy() {
    if (this.config.debug) {
      console.debug("[LogVault] Destroying client...");
    }
    await this.flush();
    if (this.batch) {
      this.batch.destroy();
    }
    for (const cleanup of this.cleanupFns) {
      cleanup();
    }
    this._initialized = false;
  }
  // ============================================================
  // Internal
  // ============================================================
  validateConfig(config) {
    if (!config.apiKey) throw new Error("[LogVault] apiKey is required");
    if (!config.apiSecret) throw new Error("[LogVault] apiSecret is required");
    if (!config.endpoint) throw new Error("[LogVault] endpoint is required");
  }
  shouldLog(level) {
    const minPriority = LOG_LEVEL_PRIORITY[this.config.minLevel || "DEBUG"];
    const currentPriority = LOG_LEVEL_PRIORITY[level];
    return currentPriority >= minPriority;
  }
  enrichMetadata(metadata) {
    const contextMeta = this.contextManager.getContextAsMetadata();
    const globalMeta = this.config.globalMetadata || {};
    const merged = {
      ...globalMeta,
      ...contextMeta,
      ...metadata
    };
    if (this.config.sanitize) {
      return this.sanitizer.sanitizeMetadata(merged) || merged;
    }
    return merged;
  }
  classifyError(error2) {
    const name = error2.name?.toLowerCase() || "";
    const message = error2.message?.toLowerCase() || "";
    if (name.includes("type") || message.includes("is not a function"))
      return "TYPE";
    if (name.includes("reference") || message.includes("is not defined"))
      return "REFERENCE";
    if (name.includes("syntax")) return "SYNTAX";
    if (name.includes("range")) return "RUNTIME";
    if (message.includes("timeout") || message.includes("timed out"))
      return "TIMEOUT";
    if (message.includes("network") || message.includes("fetch") || message.includes("econnrefused"))
      return "NETWORK";
    if (message.includes("unauthorized") || message.includes("401"))
      return "AUTHENTICATION";
    if (message.includes("forbidden") || message.includes("403"))
      return "AUTHORIZATION";
    if (message.includes("validation") || message.includes("invalid"))
      return "VALIDATION";
    if (message.includes("database") || message.includes("prisma") || message.includes("sql"))
      return "DATABASE";
    if (message.includes("memory") || message.includes("heap")) return "MEMORY";
    return "UNKNOWN";
  }
  async send(payload) {
    if (!this._initialized) return null;
    if (this.config.beforeSend) {
      const result = await this.config.beforeSend(payload);
      if (result === false) {
        if (this.config.debug) {
          console.debug("[LogVault] Event dropped by beforeSend hook");
        }
        return null;
      }
      payload = result;
    }
    try {
      let response;
      if (!this._isOnline && this.offlineQueue) {
        this.offlineQueue.enqueue(payload);
        return { success: true, id: "queued" };
      }
      if (this.batch) {
        response = await this.batch.add(payload);
      } else {
        response = await this.http.send(payload);
      }
      this.config.onSuccess?.(response);
      return response;
    } catch (err) {
      const error2 = err instanceof Error ? err : new Error(String(err));
      if (this.offlineQueue) {
        this.offlineQueue.enqueue(payload);
      }
      this.config.onError?.(error2, payload);
      if (this.config.debug) {
        console.error("[LogVault] Send failed:", error2.message);
      }
      return null;
    }
  }
  setupConnectivityListeners() {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        this._isOnline = true;
        if (this.config.debug)
          console.debug("[LogVault] Back online \u2014 draining queue");
        this.offlineQueue?.drain();
      });
      window.addEventListener("offline", () => {
        this._isOnline = false;
        if (this.config.debug)
          console.debug("[LogVault] Offline \u2014 queueing events");
      });
    }
  }
};

// src/index.ts
var defaultClient = null;
function init(config) {
  if (defaultClient) {
    console.warn(
      "[LogVault] Client already initialized \u2014 destroying previous instance"
    );
    defaultClient.destroy();
  }
  defaultClient = new LogVaultClient(config);
  return defaultClient;
}
function getClient() {
  if (!defaultClient) {
    throw new Error("[LogVault] Client not initialized. Call init() first.");
  }
  return defaultClient;
}
var log = (...args) => getClient().log(...args);
var info = (...args) => getClient().info(...args);
var warn = (...args) => getClient().warn(...args);
var error = (...args) => getClient().error(...args);
var fatal = (...args) => getClient().fatal(...args);
var trace = (...args) => getClient().trace(...args);
var captureException = (...args) => getClient().captureException(...args);
var debug = (...args) => getClient().debug(...args);
var security = (...args) => getClient().security(...args);
var setContext = (...args) => getClient().setContext(...args);
var setUser = (...args) => getClient().setUser(...args);
var flush = () => getClient().flush();
var destroy = () => getClient().destroy();

exports.LogVaultClient = LogVaultClient;
exports.PerformanceMonitor = PerformanceMonitor;
exports.Sanitizer = Sanitizer;
exports.captureException = captureException;
exports.debug = debug;
exports.destroy = destroy;
exports.error = error;
exports.fatal = fatal;
exports.flush = flush;
exports.getClient = getClient;
exports.info = info;
exports.init = init;
exports.log = log;
exports.security = security;
exports.setContext = setContext;
exports.setUser = setUser;
exports.trace = trace;
exports.warn = warn;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map