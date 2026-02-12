import {
  LogVaultConfig,
  LogLevel,
  ErrorType,
  Severity,
  SecurityType,
  Metadata,
  WebhookPayload,
  WebhookResponse,
  LogPayload,
  ErrorPayload,
  DebugPayload,
  SecurityPayload,
  LogContext,
} from "./types";
import { HttpTransport } from "./transports/http";
import { BatchTransport } from "./transports/batch";
import { OfflineQueue } from "./transports/offline-queue";
import { ContextManager } from "./context/context-manager";
import { Sanitizer } from "./utils/sanitizer";
import { PerformanceMonitor } from "./interceptors/performance";
import { setupGlobalErrorHandler } from "./interceptors/global-error";
import { setupConsoleInterceptor } from "./interceptors/console";
import { generateErrorFingerprint } from "./utils/fingerprint";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
};

export class LogVaultClient {
  private config: LogVaultConfig;
  private http: HttpTransport;
  private batch: BatchTransport | null = null;
  private offlineQueue: OfflineQueue | null = null;
  private contextManager: ContextManager;
  private sanitizer: Sanitizer;
  private cleanupFns: (() => void)[] = [];
  private _performance: PerformanceMonitor;
  private _isOnline = true;
  private _initialized = false;

  constructor(config: LogVaultConfig) {
    this.validateConfig(config);

    this.config = {
      minLevel: "DEBUG",
      sanitize: true,
      enableBatching: false,
      batchInterval: 5000,
      batchSize: 50,
      maxRetries: 3,
      retryDelay: 1000,
      timeout: 10000,
      enableOfflineQueue: false,
      maxOfflineQueueSize: 500,
      debug: false,
      ...config,
    };

    this.http = new HttpTransport(this.config);
    this.contextManager = new ContextManager();
    this.sanitizer = new Sanitizer(this.config.sensitiveFields);
    this._performance = new PerformanceMonitor(this);

    // Set up batching
    if (this.config.enableBatching) {
      this.batch = new BatchTransport(this.config, this.http);
    }

    // Set up offline queue
    if (this.config.enableOfflineQueue) {
      this.offlineQueue = new OfflineQueue(this.config, this.http);
      this.setupConnectivityListeners();
    }

    // Auto-setup interceptors
    if (this.config.captureGlobalErrors) {
      const cleanup = setupGlobalErrorHandler(this);
      this.cleanupFns.push(cleanup);
    }

    if (this.config.interceptConsole) {
      const cleanup = setupConsoleInterceptor(this);
      this.cleanupFns.push(cleanup);
    }

    // Set global metadata
    if (this.config.environment || this.config.release) {
      this.contextManager.setGlobalContext({
        extra: {
          ...(this.config.environment && {
            environment: this.config.environment,
          }),
          ...(this.config.release && { release: this.config.release }),
        },
      });
    }

    this._initialized = true;

    if (this.config.debug) {
      console.debug("[LogVault] SDK initialized", {
        endpoint: this.config.endpoint,
        batching: this.config.enableBatching,
        offlineQueue: this.config.enableOfflineQueue,
      });
    }
  }

  // ============================================================
  // Public API — Logging
  // ============================================================

  /**
   * Send a log entry
   */
  async log(
    message: string,
    options: {
      level?: LogLevel;
      metadata?: Metadata;
      source?: string;
    } = {},
  ): Promise<WebhookResponse | null> {
    const level = options.level || "INFO";

    if (!this.shouldLog(level)) return null;

    const payload: WebhookPayload = {
      type: "log",
      data: {
        level,
        message,
        metadata: this.enrichMetadata(options.metadata),
        source: options.source || this.config.defaultSource,
        timestamp: new Date().toISOString(),
      } satisfies LogPayload,
    };

    return this.send(payload);
  }

  /** Convenience: DEBUG level */
  async trace(
    message: string,
    metadata?: Metadata,
  ): Promise<WebhookResponse | null> {
    return this.log(message, { level: "DEBUG", metadata });
  }

  /** Convenience: INFO level */
  async info(
    message: string,
    metadata?: Metadata,
  ): Promise<WebhookResponse | null> {
    return this.log(message, { level: "INFO", metadata });
  }

  /** Convenience: WARN level */
  async warn(
    message: string,
    metadata?: Metadata,
  ): Promise<WebhookResponse | null> {
    return this.log(message, { level: "WARN", metadata });
  }

  /** Convenience: ERROR level */
  async error(
    message: string,
    metadata?: Metadata,
  ): Promise<WebhookResponse | null> {
    return this.log(message, { level: "ERROR", metadata });
  }

  /** Convenience: FATAL level */
  async fatal(
    message: string,
    metadata?: Metadata,
  ): Promise<WebhookResponse | null> {
    return this.log(message, { level: "FATAL", metadata });
  }

  // ============================================================
  // Public API — Error Tracking
  // ============================================================

  /**
   * Capture and report an error/exception
   */
  async captureException(
    error: Error | string,
    options: {
      type?: ErrorType;
      severity?: Severity;
      metadata?: Metadata;
    } = {},
  ): Promise<WebhookResponse | null> {
    const err = typeof error === "string" ? new Error(error) : error;
    const errorType = options.type || this.classifyError(err);
    const severity = options.severity || "MEDIUM";
    const fingerprint = generateErrorFingerprint(
      err.message,
      err.stack,
      errorType,
    );

    const payload: WebhookPayload = {
      type: "error",
      data: {
        type: errorType,
        message: err.message,
        stack: err.stack || null,
        severity,
        metadata: this.enrichMetadata({
          ...options.metadata,
          _fingerprint: fingerprint,
          _errorName: err.name,
        }),
        timestamp: new Date().toISOString(),
      } satisfies ErrorPayload,
    };

    return this.send(payload);
  }

  /**
   * Wrap an async function with automatic error capturing
   */
  wrapAsync<T extends (...args: unknown[]) => Promise<unknown>>(
    fn: T,
    options?: { severity?: Severity; metadata?: Metadata },
  ): T {
    const self = this;
    return async function (this: unknown, ...args: unknown[]) {
      try {
        return await fn.apply(this, args);
      } catch (error) {
        await self.captureException(
          error instanceof Error ? error : new Error(String(error)),
          options,
        );
        throw error; // Re-throw
      }
    } as T;
  }

  // ============================================================
  // Public API — Debug
  // ============================================================

  /**
   * Send debug/diagnostic data
   */
  async debug(options: {
    type?: string;
    data?: Metadata;
    performance?: Metadata;
  }): Promise<WebhookResponse | null> {
    const payload: WebhookPayload = {
      type: "debug",
      data: {
        type: options.type || "debug",
        data: this.enrichMetadata(options.data),
        performance: options.performance,
        timestamp: new Date().toISOString(),
      } satisfies DebugPayload,
    };

    return this.send(payload);
  }

  // ============================================================
  // Public API — Security
  // ============================================================

  /**
   * Report a security event
   */
  async security(options: {
    type?: SecurityType;
    description: string;
    ipAddress?: string;
    userAgent?: string;
    country?: string;
    metadata?: Metadata;
  }): Promise<WebhookResponse | null> {
    const payload: WebhookPayload = {
      type: "security",
      data: {
        type: options.type || "SUSPICIOUS_ACTIVITY",
        description: options.description,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
        country: options.country,
        metadata: this.enrichMetadata(options.metadata),
      } satisfies SecurityPayload,
    };

    return this.send(payload);
  }

  // ============================================================
  // Public API — Context
  // ============================================================

  /**
   * Set global context (attached to every event)
   */
  setContext(ctx: Partial<LogContext>): void {
    this.contextManager.setGlobalContext(ctx);
  }

  /**
   * Set user info
   */
  setUser(userId: string, extra?: Metadata): void {
    this.contextManager.setGlobalContext({
      userId,
      extra,
    });
  }

  /**
   * Start a scoped context (e.g., for a request)
   */
  pushScope(ctx: LogContext): void {
    this.contextManager.pushScope(ctx);
  }

  /**
   * End the current scope
   */
  popScope(): void {
    this.contextManager.popScope();
  }

  /**
   * Execute a function within a scoped context
   */
  async withScope<T>(ctx: LogContext, fn: () => Promise<T>): Promise<T> {
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

  get performance(): PerformanceMonitor {
    return this._performance;
  }

  // ============================================================
  // Public API — Lifecycle
  // ============================================================

  /**
   * Flush all pending events
   */
  async flush(): Promise<void> {
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
  async destroy(): Promise<void> {
    if (this.config.debug) {
      console.debug("[LogVault] Destroying client...");
    }

    // Flush remaining
    await this.flush();

    // Destroy batch transport
    if (this.batch) {
      this.batch.destroy();
    }

    // Remove interceptors
    for (const cleanup of this.cleanupFns) {
      cleanup();
    }

    this._initialized = false;
  }

  // ============================================================
  // Internal
  // ============================================================

  private validateConfig(config: LogVaultConfig): void {
    if (!config.apiKey) throw new Error("[LogVault] apiKey is required");
    if (!config.apiSecret) throw new Error("[LogVault] apiSecret is required");
    if (!config.endpoint) throw new Error("[LogVault] endpoint is required");
  }

  private shouldLog(level: LogLevel): boolean {
    const minPriority = LOG_LEVEL_PRIORITY[this.config.minLevel || "DEBUG"];
    const currentPriority = LOG_LEVEL_PRIORITY[level];
    return currentPriority >= minPriority;
  }

  private enrichMetadata(metadata?: Metadata): Metadata {
    const contextMeta = this.contextManager.getContextAsMetadata();
    const globalMeta = this.config.globalMetadata || {};

    const merged: Metadata = {
      ...globalMeta,
      ...contextMeta,
      ...metadata,
    };

    if (this.config.sanitize) {
      return this.sanitizer.sanitizeMetadata(merged) || merged;
    }

    return merged;
  }

  private classifyError(error: Error): ErrorType {
    const name = error.name?.toLowerCase() || "";
    const message = error.message?.toLowerCase() || "";

    if (name.includes("type") || message.includes("is not a function"))
      return "TYPE";
    if (name.includes("reference") || message.includes("is not defined"))
      return "REFERENCE";
    if (name.includes("syntax")) return "SYNTAX";
    if (name.includes("range")) return "RUNTIME";
    if (message.includes("timeout") || message.includes("timed out"))
      return "TIMEOUT";
    if (
      message.includes("network") ||
      message.includes("fetch") ||
      message.includes("econnrefused")
    )
      return "NETWORK";
    if (message.includes("unauthorized") || message.includes("401"))
      return "AUTHENTICATION";
    if (message.includes("forbidden") || message.includes("403"))
      return "AUTHORIZATION";
    if (message.includes("validation") || message.includes("invalid"))
      return "VALIDATION";
    if (
      message.includes("database") ||
      message.includes("prisma") ||
      message.includes("sql")
    )
      return "DATABASE";
    if (message.includes("memory") || message.includes("heap")) return "MEMORY";

    return "UNKNOWN";
  }

  private async send(payload: WebhookPayload): Promise<WebhookResponse | null> {
    if (!this._initialized) return null;

    // Apply beforeSend hook
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
      let response: WebhookResponse;

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
      const error = err instanceof Error ? err : new Error(String(err));

      // If offline queue enabled and we failed, queue it
      if (this.offlineQueue) {
        this.offlineQueue.enqueue(payload);
      }

      this.config.onError?.(error, payload);

      if (this.config.debug) {
        console.error("[LogVault] Send failed:", error.message);
      }

      return null;
    }
  }

  private setupConnectivityListeners(): void {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        this._isOnline = true;
        if (this.config.debug)
          console.debug("[LogVault] Back online — draining queue");
        this.offlineQueue?.drain();
      });

      window.addEventListener("offline", () => {
        this._isOnline = false;
        if (this.config.debug)
          console.debug("[LogVault] Offline — queueing events");
      });
    }
  }
}
