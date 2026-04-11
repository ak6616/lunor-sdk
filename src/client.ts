// src/client.ts

import {
  type LunorConfig,
  type WebhookPayload,
  type LogPayload,
  type ErrorPayload,
  type DebugPayload,
  type SecurityPayload,
  type MiddlewareFn,
  type PerformanceMark,
  type SDKState,
  LogLevel,
  ErrorType,
  Severity,
  SecurityType,
} from "./types";
import {
  DEFAULT_CONFIG,
  LOG_LEVEL_PRIORITY,
  LUNOR_ENDPOINT,
  SDK_VERSION,
} from "./constants";
import { Transport } from "./transport";
import { PersistentQueue } from "./queue";
import { MiddlewareChain } from "./middleware";
import { collectContext } from "./context";
import { installGlobalHandlers } from "./global-handlers";
import { scrubSensitive, scrubString, maskEmail } from "./scrubber";
import {
  validateEventPayload,
  enforceTransportSize,
} from "./validation";
import { signRequest } from "./hmac";
import {
  createInternalLogger,
  generateId,
  nowISO,
  extractStack,
  truncate,
} from "./utils";
import { HEADER_API_KEY } from "./constants";

export class LunorClient {
  // ---- Private fields ----
  private config: Required<LunorConfig> & LunorConfig;
  private transport: Transport;
  private queue: PersistentQueue;
  private middlewareChain: MiddlewareChain;
  private logger: ReturnType<typeof createInternalLogger>;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private globalHandlersCleanup: { uninstall: () => void } | null = null;
  private performanceMarks: Map<string, PerformanceMark> = new Map();
  private _state: SDKState = "idle";
  private _eventCount = 0;
  private _flushCount = 0;
  private _errorCount = 0;

  constructor(config: LunorConfig) {
    if (!config.apiKey || !config.apiSecret) {
      throw new Error("[Lunor] apiKey and apiSecret are required");
    }

    // Merge config with defaults
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    } as Required<LunorConfig> & LunorConfig;

    if (
      config.endpoint &&
      config.endpoint !== LUNOR_ENDPOINT &&
      this.config.environment === "production"
    ) {
      console.warn(
        "[Lunor] Custom endpoint is not allowed in production. Using default.",
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
      this.logger,
    );

    this._state = "initializing";
    this.logger.info(`Lunor SDK v${SDK_VERSION} initializing...`);

    // Install global handlers
    this.globalHandlersCleanup = installGlobalHandlers(this, {
      captureErrors: this.config.captureGlobalErrors,
      captureRejections: this.config.captureUnhandledRejections,
      captureConsole: this.config.captureConsole,
      consoleLevels: this.config.captureConsoleLevels,
    });

    // Start flush timer
    this.startFlushTimer();

    // Install beforeunload handler (browser) or process exit (node)
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
  log(data: LogPayload | string): void {
    const payload: LogPayload =
      typeof data === "string" ? { level: LogLevel.INFO, message: data } : data;

    if (!this.shouldSendLogLevel(payload.level || LogLevel.INFO)) return;

    // Scrub message + metadata up front so validation, persistence, and
    // transport all see only sanitized data.
    this.enqueue({
      type: "log",
      data: {
        ...payload,
        level: payload.level || LogLevel.INFO,
        source: payload.source || this.config.defaultSource,
        message: scrubString(payload.message),
        metadata: payload.metadata
          ? (scrubSensitive(payload.metadata) as Record<string, unknown>)
          : undefined,
        timestamp: payload.timestamp || nowISO(),
      },
    });
  }

  /** Shortcut: DEBUG level log */
  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log({ level: LogLevel.DEBUG, message, metadata });
  }

  /** Shortcut: INFO level log */
  info(message: string, metadata?: Record<string, unknown>): void {
    this.log({ level: LogLevel.INFO, message, metadata });
  }

  /** Shortcut: WARN level log */
  warn(message: string, metadata?: Record<string, unknown>): void {
    this.log({ level: LogLevel.WARN, message, metadata });
  }

  /** Shortcut: ERROR level log (as log, not error event) */
  errorLog(message: string, metadata?: Record<string, unknown>): void {
    this.log({ level: LogLevel.ERROR, message, metadata });
  }

  /** Shortcut: FATAL level log — immediately flushes */
  fatal(message: string, metadata?: Record<string, unknown>): void {
    this.log({ level: LogLevel.FATAL, message, metadata });
    this.flush();
  }

  // ==========================================================================
  // PUBLIC API — Errors
  // ==========================================================================

  /**
   * Capture an error event
   */
  captureError(data: ErrorPayload | Error | string): void {
    let payload: ErrorPayload;

    if (typeof data === "string") {
      payload = { message: data, severity: Severity.MEDIUM };
    } else if (data instanceof Error) {
      payload = {
        type: ErrorType.RUNTIME,
        message: data.message,
        stack: extractStack(data),
        severity: Severity.MEDIUM,
        metadata: { name: data.name },
      };
    } else {
      payload = data;
    }

    // Scrub message + stack + metadata. Stack traces in particular often
    // contain query strings / URLs with tokens when code uses fetch().
    const finalPayload: ErrorPayload = {
      ...payload,
      type: payload.type || ErrorType.UNKNOWN,
      severity: payload.severity || Severity.MEDIUM,
      message: truncate(scrubString(payload.message)),
      stack: payload.stack ? truncate(scrubString(payload.stack)) : undefined,
      metadata: payload.metadata
        ? (scrubSensitive(payload.metadata) as Record<string, unknown>)
        : undefined,
      timestamp: payload.timestamp || nowISO(),
    };

    this.enqueue({ type: "error", data: finalPayload });

    // Auto-flush for critical errors
    if (finalPayload.severity === Severity.CRITICAL) {
      this.flush();
    }
  }

  /**
   * Shortcut: capture an Error object
   */
  captureException(
    error: Error,
    extra?: { severity?: Severity; metadata?: Record<string, unknown> },
  ): void {
    this.captureError({
      type: ErrorType.RUNTIME,
      message: error.message,
      stack: extractStack(error),
      severity: extra?.severity || Severity.MEDIUM,
      metadata: {
        name: error.name,
        ...extra?.metadata,
      },
    });
  }

  // ==========================================================================
  // PUBLIC API — Debug
  // ==========================================================================

  /**
   * Send a debug/diagnostic event
   */
  captureDebug(data: DebugPayload): void {
    this.enqueue({
      type: "debug",
      data: {
        ...data,
        type: data.type || "unknown",
        timestamp: data.timestamp || nowISO(),
      },
    });
  }

  // ==========================================================================
  // PUBLIC API — Security
  // ==========================================================================

  /**
   * Report a security event
   */
  captureSecurityEvent(data: SecurityPayload): void {
    this.enqueue({
      type: "security",
      data: {
        ...data,
        type: data.type || SecurityType.SUSPICIOUS_ACTIVITY,
      },
    });

    // Security events are always flushed immediately
    this.flush();
  }

  // ==========================================================================
  // PUBLIC API — Performance
  // ==========================================================================

  /**
   * Start a performance measurement
   */
  startTimer(name: string, metadata?: Record<string, unknown>): void {
    this.performanceMarks.set(name, {
      name,
      startTime: performance.now(),
      metadata,
    });
  }

  /**
   * Stop a performance measurement and optionally send as debug event
   */
  stopTimer(name: string, sendAsDebug = true): PerformanceMark | null {
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
          endTime: mark.endTime,
        },
      });
    }

    return mark;
  }

  /**
   * Measure an async function's execution time
   */
  async measure<T>(
    name: string,
    fn: () => Promise<T>,
    metadata?: Record<string, unknown>,
  ): Promise<T> {
    this.startTimer(name, metadata);
    try {
      const result = await fn();
      this.stopTimer(name);
      return result;
    } catch (error) {
      const mark = this.stopTimer(name, false);
      this.captureError({
        type: ErrorType.RUNTIME,
        message: `Performance measurement "${name}" failed: ${(error as Error).message}`,
        stack: (error as Error).stack,
        severity: Severity.MEDIUM,
        metadata: {
          ...metadata,
          duration: mark?.duration,
        },
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
  use(middleware: MiddlewareFn): this {
    this.middlewareChain.use(middleware);
    return this;
  }

  // ==========================================================================
  // PUBLIC API — Context
  // ==========================================================================

  /**
   * Update global context (merged with existing)
   */
  setContext(context: Record<string, unknown>): void {
    this.config.globalContext = {
      ...(this.config.globalContext || {}),
      ...context,
    };
  }

  /**
   * Set a tag
   */
  setTag(key: string, value: string): void {
    if (!this.config.tags) this.config.tags = {};
    this.config.tags[key] = value;
  }

  /**
   * Set the user context
   */
  setUser(user: {
    id?: string;
    email?: string;
    name?: string;
    [key: string]: unknown;
  }): void {
    // Mask email if present, then run the whole object through the scrubber
    // so any custom fields (token, password, etc.) are also redacted.
    const masked: Record<string, unknown> = { ...user };
    if (typeof masked.email === "string") {
      masked.email = maskEmail(masked.email);
    }
    this.setContext({
      user: scrubSensitive(masked) as Record<string, unknown>,
    });
  }

  // ==========================================================================
  // PUBLIC API — Flush & Lifecycle
  // ==========================================================================

  /**
   * Force an immediate flush of the queue
   */
  async forceFlush(): Promise<void> {
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
      sdkVersion: SDK_VERSION,
    };
  }

  /**
   * Destroy the SDK instance — flushes remaining events and cleans up
   */
  async destroy(): Promise<void> {
    this.logger.info("Destroying Lunor SDK...");
    this._state = "destroyed";

    // Stop timers
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Uninstall global handlers
    this.globalHandlersCleanup?.uninstall();

    // Final flush
    await this.flush();

    this.logger.info("Lunor SDK destroyed");
  }

  // ==========================================================================
  // INTERNAL METHODS
  // ==========================================================================

  private shouldSendLogLevel(level: LogLevel): boolean {
    const minPriority = LOG_LEVEL_PRIORITY[this.config.minLogLevel] ?? 0;
    const currentPriority = LOG_LEVEL_PRIORITY[level] ?? 0;
    return currentPriority >= minPriority;
  }

  private shouldSample(): boolean {
    if (this.config.sampleRate >= 1.0) return true;
    if (this.config.sampleRate <= 0.0) return false;
    return Math.random() < this.config.sampleRate;
  }

  private async enqueue(payload: WebhookPayload): Promise<void> {
    if (this._state === "destroyed") {
      this.logger.warn("SDK destroyed, dropping event");
      return;
    }

    // Sampling
    if (!this.shouldSample()) {
      this.logger.debug("Event dropped by sampling");
      return;
    }

    // Enrich with metadata
    payload._meta = {
      sdkVersion: SDK_VERSION,
      timestamp: nowISO(),
      context: {
        ...collectContext(this.config),
        ...(this.config.globalContext
          ? {
              tags: {
                ...(this.config.tags || {}),
                ...(this.config.globalContext as Record<string, string>),
              },
            }
          : {}),
      },
    };

    // Run beforeSend hook
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

    // Run middleware chain
    if (this.middlewareChain.count > 0) {
      const processed = await this.middlewareChain.execute(payload);
      if (!processed) {
        this.logger.debug("Event dropped by middleware");
        return;
      }
      payload = processed;
    }

    // Validate + size-limit check. Rejected events are dropped with a warning.
    const validated = validateEventPayload(payload, this.logger);
    if (!validated) return;
    payload = validated;

    this.queue.enqueue(payload);
    this._eventCount++;

    this.logger.debug(
      `Queued ${payload.type} event (queue: ${this.queue.size})`,
    );

    // Auto-flush if batch size reached
    if (this.queue.size >= this.config.batchSize) {
      this.flush();
    }
  }

  private async flush(): Promise<void> {
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
        // Requeue items that haven't exceeded max retries
        const retriable = failedItems.filter(
          (item) => item.retries < this.config.maxRetries,
        );
        const dropped = failedItems.filter(
          (item) => item.retries >= this.config.maxRetries,
        );

        if (retriable.length > 0) {
          this.queue.requeue(retriable);
          this.logger.warn(`${retriable.length} events requeued for retry`);
        }

        if (dropped.length > 0) {
          this._errorCount += dropped.length;
          this.logger.error(
            `${dropped.length} events permanently dropped after max retries`,
          );
          this.config.onFlushError?.(
            new Error(`${dropped.length} events failed`),
            dropped.map((i) => i.payload),
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
      // Requeue all on catastrophic failure
      this.queue.requeue(items);
      this._errorCount++;
      this.logger.error("Flush failed catastrophically:", error);
      this.config.onFlushError?.(
        error instanceof Error ? error : new Error(String(error)),
        payloads,
      );
    } finally {
      this._state = previousState === "destroyed" ? "destroyed" : "ready";
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.config.flushInterval);
  }

  private installShutdownHandler(): void {
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        // Use sendBeacon for last-chance delivery
        this.sendBeaconFlush();
      });

      // Visibility change — flush when tab goes to background
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
   * Last-chance delivery when the page is closing (browser only).
   *
   * apiSecret MUST NEVER appear in the request body. To satisfy HMAC v1 we
   * need custom headers (X-Lunor-Signature, X-Lunor-Timestamp, X-API-Key).
   *
   * Strategy:
   *   1. Prefer `fetch` with `keepalive: true` — modern browsers allow up to
   *      64KB per request, and it DOES support custom headers, so we can
   *      ship a properly-signed request exactly like the normal transport.
   *   2. Fallback to `navigator.sendBeacon` ONLY when keepalive fetch is
   *      unavailable. sendBeacon cannot set custom headers, so we embed the
   *      HMAC signature and timestamp into the JSON body under the reserved
   *      `__sig` / `__ts` / `__key` fields. The Lunor backend must accept
   *      these as an alternate auth channel. The apiSecret is NEVER embedded.
   */
  private sendBeaconFlush(): void {
    if (typeof navigator === "undefined") return;

    const items = this.queue.drain();
    if (items.length === 0) return;

    // Detect whether keepalive fetch is supported. Best-effort: if `fetch`
    // exists we assume it supports `keepalive` (all evergreen browsers do).
    const keepaliveSupported =
      typeof fetch === "function" && typeof Request !== "undefined";

    for (const item of items) {
      // Sanity scrub + validation before last-chance send.
      const scrubbed = scrubSensitive(item.payload) as WebhookPayload;
      const rawBody = JSON.stringify(scrubbed);

      const checkedSize = enforceTransportSize(
        rawBody,
        keepaliveSupported ? "fetch" : "beacon",
        this.logger,
      );
      if (checkedSize === null) continue;

      if (keepaliveSupported) {
        // Preferred path: signed fetch with keepalive flag.
        signRequest(this.config.apiSecret, checkedSize)
          .then((signed) => {
            return fetch(this.config.endpoint!, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                [HEADER_API_KEY]: this.config.apiKey,
                ...signed,
              },
              body: checkedSize,
              keepalive: true,
            }).catch(() => {
              /* best effort */
            });
          })
          .catch(() => {
            /* best effort */
          });
        continue;
      }

      // Legacy fallback: navigator.sendBeacon. Signature must travel inside
      // the body since no custom headers are permitted. apiSecret remains
      // out of the body at all times.
      if (!navigator.sendBeacon) continue;
      // We sign the unsigned body here. Backend will re-read the `__sig` /
      // `__ts` fields as the authenticator (NOT the HMAC of the final body)
      // and treat this as beacon-mode auth. Documented tradeoff: beacon
      // signature covers the body MINUS the auth fields, so the backend must
      // strip __sig/__ts/__key before recomputing.
      const ts = Math.floor(Date.now() / 1000).toString();
      signRequest(this.config.apiSecret, `${ts}.${checkedSize}`, ts)
        .then((signed) => {
          try {
            const enriched = {
              ...scrubbed,
              __key: this.config.apiKey,
              __ts: ts,
              __sig: signed["X-Lunor-Signature"],
            };
            const finalBody = JSON.stringify(enriched);
            const finalChecked = enforceTransportSize(
              finalBody,
              "beacon",
              this.logger,
            );
            if (finalChecked === null) return;
            navigator.sendBeacon(
              this.config.endpoint!,
              new Blob([finalChecked], { type: "application/json" }),
            );
          } catch {
            /* best effort */
          }
        })
        .catch(() => {
          /* best effort */
        });
    }
  }
}
