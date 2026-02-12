/** Log severity levels */
type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
/** Error classification types */
type ErrorType = "RUNTIME" | "SYNTAX" | "TYPE" | "REFERENCE" | "NETWORK" | "VALIDATION" | "DATABASE" | "AUTHENTICATION" | "AUTHORIZATION" | "TIMEOUT" | "MEMORY" | "UNKNOWN";
/** Error severity levels */
type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
/** Security event types */
type SecurityType = "AUTH_FAILURE" | "BRUTE_FORCE" | "XSS_ATTEMPT" | "SQL_INJECTION" | "CSRF_ATTEMPT" | "RATE_LIMIT" | "SUSPICIOUS_ACTIVITY" | "DATA_BREACH" | "UNAUTHORIZED_ACCESS" | "PRIVILEGE_ESCALATION";
/** Generic metadata object */
type Metadata = Record<string, unknown>;
interface LogPayload {
    level?: LogLevel;
    message: string;
    metadata?: Metadata;
    source?: string;
    timestamp?: string;
}
interface ErrorPayload {
    type?: ErrorType;
    message: string;
    stack?: string | null;
    metadata?: Metadata | null;
    severity?: Severity;
    timestamp?: string;
}
interface DebugPayload {
    type?: string;
    data?: Metadata;
    performance?: Metadata | null;
    timestamp?: string;
}
interface SecurityPayload {
    type?: SecurityType;
    ipAddress?: string;
    userAgent?: string | null;
    country?: string | null;
    description?: string;
    metadata?: Metadata | null;
}
interface WebhookPayload {
    type: "log" | "error" | "debug" | "security";
    data: LogPayload | ErrorPayload | DebugPayload | SecurityPayload;
}
interface WebhookResponse {
    success: boolean;
    id?: string;
    type?: string;
    error?: string;
}
interface LogVaultConfig {
    /** Your LogVault API key */
    apiKey: string;
    /** Your LogVault API secret */
    apiSecret: string;
    /** LogVault webhook endpoint URL */
    endpoint: string;
    /** Enable automatic global error catching (default: false) */
    captureGlobalErrors?: boolean;
    /** Intercept console.log/warn/error (default: false) */
    interceptConsole?: boolean;
    /** Enable performance monitoring (default: false) */
    enablePerformance?: boolean;
    /** Minimum log level to send (default: 'DEBUG') */
    minLevel?: LogLevel;
    /** Enable batching — send logs in batches (default: false) */
    enableBatching?: boolean;
    /** Batch flush interval in ms (default: 5000) */
    batchInterval?: number;
    /** Max batch size before auto-flush (default: 50) */
    batchSize?: number;
    /** Max retry attempts for failed requests (default: 3) */
    maxRetries?: number;
    /** Retry delay in ms (default: 1000) */
    retryDelay?: number;
    /** Request timeout in ms (default: 10000) */
    timeout?: number;
    /** Enable offline queue — store events when offline (default: false) */
    enableOfflineQueue?: boolean;
    /** Max offline queue size (default: 500) */
    maxOfflineQueueSize?: number;
    /** Sanitize sensitive fields from metadata (default: true) */
    sanitize?: boolean;
    /** Fields to redact (default: common sensitive fields) */
    sensitiveFields?: string[];
    /** Global metadata attached to every event */
    globalMetadata?: Metadata;
    /** Application environment */
    environment?: string;
    /** Application version / release tag */
    release?: string;
    /** Default source tag */
    defaultSource?: string;
    /** Hook called before each event is sent — return false to drop */
    beforeSend?: (event: WebhookPayload) => WebhookPayload | false | Promise<WebhookPayload | false>;
    /** Hook called after successful send */
    onSuccess?: (response: WebhookResponse) => void;
    /** Hook called on send error */
    onError?: (error: Error, event: WebhookPayload) => void;
    /** Enable SDK debug mode (default: false) */
    debug?: boolean;
}
interface BatchItem {
    payload: WebhookPayload;
    resolve: (value: WebhookResponse) => void;
    reject: (reason: Error) => void;
}
interface LogContext {
    userId?: string;
    sessionId?: string;
    requestId?: string;
    traceId?: string;
    tags?: string[];
    extra?: Metadata;
}
interface PerformanceEntry {
    name: string;
    startTime: number;
    endTime?: number;
    duration?: number;
    metadata?: Metadata;
}
interface QueuedEvent {
    payload: WebhookPayload;
    timestamp: number;
    retries: number;
}

declare class PerformanceMonitor {
    private client;
    private entries;
    constructor(client: LogVaultClient);
    startTimer(name: string, metadata?: Record<string, unknown>): () => void;
    stopTimer(name: string): PerformanceEntry | null;
    /**
     * Measure an async operation
     */
    measure<T>(name: string, fn: () => Promise<T>, metadata?: Record<string, unknown>): Promise<T>;
    /**
     * Wrap a function with automatic performance tracking
     */
    wrap<T extends (...args: unknown[]) => unknown>(name: string, fn: T): T;
}

declare class LogVaultClient {
    private config;
    private http;
    private batch;
    private offlineQueue;
    private contextManager;
    private sanitizer;
    private cleanupFns;
    private _performance;
    private _isOnline;
    private _initialized;
    constructor(config: LogVaultConfig);
    /**
     * Send a log entry
     */
    log(message: string, options?: {
        level?: LogLevel;
        metadata?: Metadata;
        source?: string;
    }): Promise<WebhookResponse | null>;
    /** Convenience: DEBUG level */
    trace(message: string, metadata?: Metadata): Promise<WebhookResponse | null>;
    /** Convenience: INFO level */
    info(message: string, metadata?: Metadata): Promise<WebhookResponse | null>;
    /** Convenience: WARN level */
    warn(message: string, metadata?: Metadata): Promise<WebhookResponse | null>;
    /** Convenience: ERROR level */
    error(message: string, metadata?: Metadata): Promise<WebhookResponse | null>;
    /** Convenience: FATAL level */
    fatal(message: string, metadata?: Metadata): Promise<WebhookResponse | null>;
    /**
     * Capture and report an error/exception
     */
    captureException(error: Error | string, options?: {
        type?: ErrorType;
        severity?: Severity;
        metadata?: Metadata;
    }): Promise<WebhookResponse | null>;
    /**
     * Wrap an async function with automatic error capturing
     */
    wrapAsync<T extends (...args: unknown[]) => Promise<unknown>>(fn: T, options?: {
        severity?: Severity;
        metadata?: Metadata;
    }): T;
    /**
     * Send debug/diagnostic data
     */
    debug(options: {
        type?: string;
        data?: Metadata;
        performance?: Metadata;
    }): Promise<WebhookResponse | null>;
    /**
     * Report a security event
     */
    security(options: {
        type?: SecurityType;
        description: string;
        ipAddress?: string;
        userAgent?: string;
        country?: string;
        metadata?: Metadata;
    }): Promise<WebhookResponse | null>;
    /**
     * Set global context (attached to every event)
     */
    setContext(ctx: Partial<LogContext>): void;
    /**
     * Set user info
     */
    setUser(userId: string, extra?: Metadata): void;
    /**
     * Start a scoped context (e.g., for a request)
     */
    pushScope(ctx: LogContext): void;
    /**
     * End the current scope
     */
    popScope(): void;
    /**
     * Execute a function within a scoped context
     */
    withScope<T>(ctx: LogContext, fn: () => Promise<T>): Promise<T>;
    get performance(): PerformanceMonitor;
    /**
     * Flush all pending events
     */
    flush(): Promise<void>;
    /**
     * Destroy the client — flush and clean up
     */
    destroy(): Promise<void>;
    private validateConfig;
    private shouldLog;
    private enrichMetadata;
    private classifyError;
    private send;
    private setupConnectivityListeners;
}

declare class Sanitizer {
    private sensitiveFields;
    constructor(customFields?: string[]);
    sanitize(data: unknown, depth?: number): unknown;
    sanitizeMetadata(metadata: Metadata | undefined): Metadata | undefined;
}

/**
 * Initialize the default LogVault client (singleton)
 */
declare function init(config: LogVaultConfig): LogVaultClient;
/**
 * Get the default client instance
 */
declare function getClient(): LogVaultClient;
declare const log: (...args: Parameters<LogVaultClient["log"]>) => Promise<WebhookResponse | null>;
declare const info: (...args: Parameters<LogVaultClient["info"]>) => Promise<WebhookResponse | null>;
declare const warn: (...args: Parameters<LogVaultClient["warn"]>) => Promise<WebhookResponse | null>;
declare const error: (...args: Parameters<LogVaultClient["error"]>) => Promise<WebhookResponse | null>;
declare const fatal: (...args: Parameters<LogVaultClient["fatal"]>) => Promise<WebhookResponse | null>;
declare const trace: (...args: Parameters<LogVaultClient["trace"]>) => Promise<WebhookResponse | null>;
declare const captureException: (...args: Parameters<LogVaultClient["captureException"]>) => Promise<WebhookResponse | null>;
declare const debug: (...args: Parameters<LogVaultClient["debug"]>) => Promise<WebhookResponse | null>;
declare const security: (...args: Parameters<LogVaultClient["security"]>) => Promise<WebhookResponse | null>;
declare const setContext: (...args: Parameters<LogVaultClient["setContext"]>) => void;
declare const setUser: (...args: Parameters<LogVaultClient["setUser"]>) => void;
declare const flush: () => Promise<void>;
declare const destroy: () => Promise<void>;

export { type BatchItem, type DebugPayload, type ErrorPayload, type ErrorType, type LogContext, type LogLevel, type LogPayload, LogVaultClient, type LogVaultConfig, type Metadata, type PerformanceEntry, PerformanceMonitor, type QueuedEvent, Sanitizer, type SecurityPayload, type SecurityType, type Severity, type WebhookPayload, type WebhookResponse, captureException, debug, destroy, error, fatal, flush, getClient, info, init, log, security, setContext, setUser, trace, warn };
