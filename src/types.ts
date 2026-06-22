// src/types.ts

// ============================================================================
// ENUMS (mirrors Prisma schema)
// ============================================================================

export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
  FATAL = "FATAL",
}

export enum ErrorType {
  RUNTIME = "RUNTIME",
  SYNTAX = "SYNTAX",
  NETWORK = "NETWORK",
  DATABASE = "DATABASE",
  AUTHENTICATION = "AUTHENTICATION",
  AUTHORIZATION = "AUTHORIZATION",
  VALIDATION = "VALIDATION",
  TIMEOUT = "TIMEOUT",
  MEMORY = "MEMORY",
  UNKNOWN = "UNKNOWN",
}

export enum Severity {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

export enum SecurityType {
  BRUTE_FORCE = "BRUTE_FORCE",
  UNAUTHORIZED_ACCESS = "UNAUTHORIZED_ACCESS",
  SUSPICIOUS_ACTIVITY = "SUSPICIOUS_ACTIVITY",
  DATA_BREACH = "DATA_BREACH",
  INJECTION_ATTEMPT = "INJECTION_ATTEMPT",
  XSS_ATTEMPT = "XSS_ATTEMPT",
  CSRF_ATTEMPT = "CSRF_ATTEMPT",
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",
  INVALID_TOKEN = "INVALID_TOKEN",
  IP_BLACKLISTED = "IP_BLACKLISTED",
  FIREWALL_BLOCK = "FIREWALL_BLOCK",
  FIREWALL_WOULD_BLOCK = "FIREWALL_WOULD_BLOCK",
}

// ============================================================================
// PAYLOAD TYPES
// ============================================================================

export interface LogPayload {
  level?: LogLevel;
  message: string;
  metadata?: Record<string, unknown>;
  source?: string;
  timestamp?: string;
}

export interface ErrorPayload {
  type?: ErrorType;
  message: string;
  stack?: string;
  metadata?: Record<string, unknown>;
  severity?: Severity;
  timestamp?: string;
}

export interface DebugPayload {
  type?: string;
  data?: Record<string, unknown>;
  performance?: Record<string, unknown>;
  timestamp?: string;
}

export interface SecurityPayload {
  type?: SecurityType;
  ipAddress?: string;
  userAgent?: string;
  country?: string;
  description: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// WEBHOOK PAYLOAD
// ============================================================================

export interface WebhookPayload {
  type: "log" | "error" | "debug" | "security";
  data: LogPayload | ErrorPayload | DebugPayload | SecurityPayload;
  _meta?: {
    sdkVersion: string;
    timestamp: string;
    context?: ContextData;
    batchId?: string;
  };
}

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface LunorConfig {
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
  beforeSend?: (
    payload: WebhookPayload,
  ) => WebhookPayload | false | Promise<WebhookPayload | false>;

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

// ============================================================================
// CONTEXT
// ============================================================================

export interface ContextData {
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

// ============================================================================
// MIDDLEWARE
// ============================================================================

export type MiddlewareFn = (
  payload: WebhookPayload,
  next: () => void,
) => void | Promise<void>;

// ============================================================================
// TRANSPORT
// ============================================================================

export interface TransportResponse {
  success: boolean;
  id?: string;
  type?: string;
  error?: string;
  status?: number;
}

// ============================================================================
// QUEUE ITEM
// ============================================================================

export interface QueueItem {
  id: string;
  payload: WebhookPayload;
  retries: number;
  createdAt: number;
  lastAttempt?: number;
}

// ============================================================================
// PERFORMANCE
// ============================================================================

export interface PerformanceMark {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// SDK STATE
// ============================================================================

export type SDKState =
  | "idle"
  | "initializing"
  | "ready"
  | "flushing"
  | "destroyed";
