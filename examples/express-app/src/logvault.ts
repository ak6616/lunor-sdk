import { init, LogVaultClient } from "@LogVault/sdk";

// Initialize with full configuration
const LogVault: LogVaultClient = init({
  // Core credentials (from your LogVault dashboard)
  apiKey: process.env.LogVault_API_KEY!,
  apiSecret: process.env.LogVault_API_SECRET!,
  endpoint: process.env.LogVault_ENDPOINT || "https://your-app.com/api/webhook",

  // Environment info
  environment: process.env.NODE_ENV || "development",
  release: process.env.APP_VERSION || "1.0.0",
  defaultSource: "express-api",

  // Automatic error capturing
  captureGlobalErrors: true,

  // Batching for high-throughput
  enableBatching: true,
  batchInterval: 3000,
  batchSize: 25,

  // Retry config
  maxRetries: 3,
  retryDelay: 1000,
  timeout: 5000,

  // Security — sanitize sensitive fields
  sanitize: true,
  sensitiveFields: ["password", "creditCard", "ssn", "jwt"],

  // Global metadata attached to every event
  globalMetadata: {
    service: "user-api",
    hostname: process.env.HOSTNAME,
    pid: process.pid,
  },

  // Minimum log level (skip DEBUG in production)
  minLevel: process.env.NODE_ENV === "production" ? "INFO" : "DEBUG",

  // Hooks
  beforeSend: (event) => {
    // Don't send health check logs
    if (
      event.type === "log" &&
      (event.data as { message?: string }).message?.includes("health check")
    ) {
      return false;
    }
    return event;
  },

  onError: (error, event) => {
    console.error(`[LogVault] Failed to send ${event.type}:`, error.message);
  },

  debug: process.env.NODE_ENV === "development",
});

export default LogVault;
