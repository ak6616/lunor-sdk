// ============================================================
// LogVault SDK — Type Definitions
// ============================================================

/** Log severity levels */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

/** Error classification types */
export type ErrorType =
  | "RUNTIME"
  | "SYNTAX"
  | "TYPE"
  | "REFERENCE"
  | "NETWORK"
  | "VALIDATION"
  | "DATABASE"
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "TIMEOUT"
  | "MEMORY"
  | "UNKNOWN";

/** Error severity levels */
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Security event types */
export type SecurityType =
  | "AUTH_FAILURE"
  | "BRUTE_FORCE"
  | "XSS_ATTEMPT"
  | "SQL_INJECTION"
  | "CSRF_ATTEMPT"
  | "RATE_LIMIT"
  | "SUSPICIOUS_ACTIVITY"
  | "DATA_BREACH"
  | "UNAUTHORIZED_ACCESS"
  | "PRIVILEGE_ESCALATION";

/** Generic metadata object */
export type Metadata = Record<string, unknown>;

// ---- Payloads ----

export interface LogPayload {
  level?: LogLevel;
  message: string;
  metadata?: Metadata;
  source?: string;
  timestamp?: string;
}

export interface ErrorPayload {
  type?: ErrorType;
  message: string;
  stack?: string | null; // ← dodaj | null
  metadata?: Metadata | null; // ← dodaj | null
  severity?: Severity;
  timestamp?: string;
}

export interface DebugPayload {
  type?: string;
  data?: Metadata;
  performance?: Metadata | null; // ← dodaj | null
  timestamp?: string;
}

export interface SecurityPayload {
  type?: SecurityType;
  ipAddress?: string;
  userAgent?: string | null; // ← dodaj | null
  country?: string | null; // ← dodaj | null
  description?: string;
  metadata?: Metadata | null; // ← dodaj | null
}

// ---- Webhook ----

export interface WebhookPayload {
  type: "log" | "error" | "debug" | "security";
  data: LogPayload | ErrorPayload | DebugPayload | SecurityPayload;
}

export interface WebhookResponse {
  success: boolean;
  id?: string;
  type?: string;
  error?: string;
}

// ---- SDK Configuration ----

export interface LogVaultConfig {
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
  beforeSend?: (
    event: WebhookPayload,
  ) => WebhookPayload | false | Promise<WebhookPayload | false>;

  /** Hook called after successful send */
  onSuccess?: (response: WebhookResponse) => void;

  /** Hook called on send error */
  onError?: (error: Error, event: WebhookPayload) => void;

  /** Enable SDK debug mode (default: false) */
  debug?: boolean;
}

// ---- Batch ----

export interface BatchItem {
  payload: WebhookPayload;
  resolve: (value: WebhookResponse) => void;
  reject: (reason: Error) => void;
}

// ---- Context ----

export interface LogContext {
  userId?: string;
  sessionId?: string;
  requestId?: string;
  traceId?: string;
  tags?: string[];
  extra?: Metadata;
}

// ---- Performance ----

export interface PerformanceEntry {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: Metadata;
}

// ---- Internal ----

export interface QueuedEvent {
  payload: WebhookPayload;
  timestamp: number;
  retries: number;
}
