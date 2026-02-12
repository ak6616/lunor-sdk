declare enum LogLevel {
    DEBUG = "DEBUG",
    INFO = "INFO",
    WARN = "WARN",
    ERROR = "ERROR",
    FATAL = "FATAL"
}
declare enum ErrorType {
    RUNTIME = "RUNTIME",
    SYNTAX = "SYNTAX",
    NETWORK = "NETWORK",
    DATABASE = "DATABASE",
    AUTHENTICATION = "AUTHENTICATION",
    AUTHORIZATION = "AUTHORIZATION",
    VALIDATION = "VALIDATION",
    TIMEOUT = "TIMEOUT",
    MEMORY = "MEMORY",
    UNKNOWN = "UNKNOWN"
}
declare enum Severity {
    LOW = "LOW",
    MEDIUM = "MEDIUM",
    HIGH = "HIGH",
    CRITICAL = "CRITICAL"
}
declare enum SecurityType {
    BRUTE_FORCE = "BRUTE_FORCE",
    UNAUTHORIZED_ACCESS = "UNAUTHORIZED_ACCESS",
    SUSPICIOUS_ACTIVITY = "SUSPICIOUS_ACTIVITY",
    DATA_BREACH = "DATA_BREACH",
    INJECTION_ATTEMPT = "INJECTION_ATTEMPT",
    XSS_ATTEMPT = "XSS_ATTEMPT",
    CSRF_ATTEMPT = "CSRF_ATTEMPT",
    RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",
    INVALID_TOKEN = "INVALID_TOKEN",
    IP_BLACKLISTED = "IP_BLACKLISTED"
}
interface LogPayload {
    level?: LogLevel;
    message: string;
    metadata?: Record<string, unknown>;
    source?: string;
    timestamp?: string;
}
interface ErrorPayload {
    type?: ErrorType;
    message: string;
    stack?: string;
    metadata?: Record<string, unknown>;
    severity?: Severity;
    timestamp?: string;
}
interface DebugPayload {
    type?: string;
    data?: Record<string, unknown>;
    performance?: Record<string, unknown>;
    timestamp?: string;
}
interface SecurityPayload {
    type?: SecurityType;
    ipAddress?: string;
    userAgent?: string;
    country?: string;
    description: string;
    metadata?: Record<string, unknown>;
}
interface WebhookPayload {
    type: "log" | "error" | "debug" | "security";
    data: LogPayload | ErrorPayload | DebugPayload | SecurityPayload;
    _meta?: {
        sdkVersion: string;
        timestamp: string;
        context?: ContextData;
        batchId?: string;
    };
}
interface LunorConfig {
    /** API Key from your Lunor project */
    apiKey: string;
    /** API Secret from your Lunor project */
    apiSecret: string;
    /** Webhook endpoint URL */
    endpoint?: string;
    /** Maximum items per batch flush */
    batchSize?: number;
    /** Interval (ms) between automatic flushes */
    flushInterval?: number;
    /** Maximum retry attempts per event */
    maxRetries?: number;
    /** Base delay (ms) for exponential backoff */
    retryBaseDelay?: number;
    /** Maximum delay (ms) for exponential backoff */
    retryMaxDelay?: number;
    /** Request timeout (ms) */
    timeout?: number;
    /** Enable automatic global error capturing */
    captureGlobalErrors?: boolean;
    /** Enable automatic unhandled rejection capturing */
    captureUnhandledRejections?: boolean;
    /** Enable console method interception */
    captureConsole?: boolean;
    /** Console levels to capture */
    captureConsoleLevels?: ("error" | "warn" | "log" | "debug")[];
    /** Enable offline queue persistence (browser: localStorage, node: file) */
    enablePersistence?: boolean;
    /** Storage key prefix for persistence */
    persistencePrefix?: string;
    /** Maximum items to keep in queue */
    maxQueueSize?: number;
    /** Minimum log level to send (events below this are dropped) */
    minLogLevel?: LogLevel;
    /** Enable debug mode (verbose SDK logging) */
    debug?: boolean;
    /** Default source tag for logs */
    defaultSource?: string;
    /** Extra context to attach to every event */
    globalContext?: Record<string, unknown>;
    /** Environment tag */
    environment?: string;
    /** Release/version tag */
    release?: string;
    /** Tags to attach to every event */
    tags?: Record<string, string>;
    /** Called before each event is queued — return false to drop */
    beforeSend?: (payload: WebhookPayload) => WebhookPayload | false | Promise<WebhookPayload | false>;
    /** Called after a successful flush */
    onFlushSuccess?: (count: number) => void;
    /** Called when a flush fails after all retries */
    onFlushError?: (error: Error, failedItems: WebhookPayload[]) => void;
    /** Called when the SDK is ready */
    onReady?: () => void;
    /** Sampling rate 0.0 - 1.0 (1.0 = send everything) */
    sampleRate?: number;
    /** Enable automatic performance tracking */
    enablePerformance?: boolean;
}
interface ContextData {
    environment?: string;
    release?: string;
    tags?: Record<string, string>;
    runtime?: "browser" | "node" | "edge" | "unknown";
    os?: string;
    hostname?: string;
    userAgent?: string;
    url?: string;
    locale?: string;
    timezone?: string;
    screenResolution?: string;
    memoryUsage?: Record<string, number>;
    nodeVersion?: string;
    pid?: number;
}
type MiddlewareFn = (payload: WebhookPayload, next: () => void) => void | Promise<void>;
interface TransportResponse {
    success: boolean;
    id?: string;
    type?: string;
    error?: string;
    status?: number;
}
interface PerformanceMark {
    name: string;
    startTime: number;
    endTime?: number;
    duration?: number;
    metadata?: Record<string, unknown>;
}
type SDKState = "idle" | "initializing" | "ready" | "flushing" | "destroyed";

declare class LunorClient {
    private config;
    private transport;
    private queue;
    private middlewareChain;
    private logger;
    private flushTimer;
    private globalHandlersCleanup;
    private performanceMarks;
    private _state;
    private _eventCount;
    private _flushCount;
    private _errorCount;
    constructor(config: LunorConfig);
    /**
     * Send a log event
     */
    log(data: LogPayload | string): void;
    /** Shortcut: DEBUG level log */
    debug(message: string, metadata?: Record<string, unknown>): void;
    /** Shortcut: INFO level log */
    info(message: string, metadata?: Record<string, unknown>): void;
    /** Shortcut: WARN level log */
    warn(message: string, metadata?: Record<string, unknown>): void;
    /** Shortcut: ERROR level log (as log, not error event) */
    errorLog(message: string, metadata?: Record<string, unknown>): void;
    /** Shortcut: FATAL level log — immediately flushes */
    fatal(message: string, metadata?: Record<string, unknown>): void;
    /**
     * Capture an error event
     */
    captureError(data: ErrorPayload | Error | string): void;
    /**
     * Shortcut: capture an Error object
     */
    captureException(error: Error, extra?: {
        severity?: Severity;
        metadata?: Record<string, unknown>;
    }): void;
    /**
     * Send a debug/diagnostic event
     */
    captureDebug(data: DebugPayload): void;
    /**
     * Report a security event
     */
    captureSecurityEvent(data: SecurityPayload): void;
    /**
     * Start a performance measurement
     */
    startTimer(name: string, metadata?: Record<string, unknown>): void;
    /**
     * Stop a performance measurement and optionally send as debug event
     */
    stopTimer(name: string, sendAsDebug?: boolean): PerformanceMark | null;
    /**
     * Measure an async function's execution time
     */
    measure<T>(name: string, fn: () => Promise<T>, metadata?: Record<string, unknown>): Promise<T>;
    /**
     * Add a middleware that processes events before they're queued
     */
    use(middleware: MiddlewareFn): this;
    /**
     * Update global context (merged with existing)
     */
    setContext(context: Record<string, unknown>): void;
    /**
     * Set a tag
     */
    setTag(key: string, value: string): void;
    /**
     * Set the user context
     */
    setUser(user: {
        id?: string;
        email?: string;
        name?: string;
        [key: string]: unknown;
    }): void;
    /**
     * Force an immediate flush of the queue
     */
    forceFlush(): Promise<void>;
    /**
     * Get SDK stats
     */
    getStats(): {
        state: SDKState;
        queueSize: number;
        totalEvents: number;
        totalFlushes: number;
        totalErrors: number;
        sdkVersion: string;
    };
    /**
     * Destroy the SDK instance — flushes remaining events and cleans up
     */
    destroy(): Promise<void>;
    private shouldSendLogLevel;
    private shouldSample;
    private enqueue;
    private flush;
    private startFlushTimer;
    private installShutdownHandler;
    /**
     * Use navigator.sendBeacon for last-chance delivery (browser only)
     */
    private sendBeaconFlush;
}

/**
 * Create a new Lunor client instance
 */
declare function createLunorClient(config: LunorConfig): LunorClient;
/**
 * Initialize the global singleton instance
 */
declare function init(config: LunorConfig): LunorClient;
/**
 * Get the global singleton instance (throws if not initialized)
 */
declare function getInstance(): LunorClient;
/**
 * Destroy the global singleton instance
 */
declare function destroy(): Promise<void>;
declare const _default: {
    init: typeof init;
    getInstance: typeof getInstance;
    destroy: typeof destroy;
    createLunorClient: typeof createLunorClient;
    LunorClient: typeof LunorClient;
    LogLevel: typeof LogLevel;
    ErrorType: typeof ErrorType;
    Severity: typeof Severity;
    SecurityType: typeof SecurityType;
};

export { type ContextData, type DebugPayload, type ErrorPayload, ErrorType, LogLevel, type LogPayload, LunorClient, type LunorConfig, type MiddlewareFn, type PerformanceMark, type SecurityPayload, SecurityType, Severity, type TransportResponse, type WebhookPayload, createLunorClient, _default as default, destroy, getInstance, init };
