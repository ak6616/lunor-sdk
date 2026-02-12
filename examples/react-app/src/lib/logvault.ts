import { init } from "@LogVault/sdk";

const LogVault = init({
  apiKey: import.meta.env.VITE_LogVault_API_KEY,
  apiSecret: import.meta.env.VITE_LogVault_API_SECRET,
  endpoint: import.meta.env.VITE_LogVault_ENDPOINT,

  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_APP_VERSION || "1.0.0",
  defaultSource: "react-frontend",

  // Catch unhandled errors and promise rejections
  captureGlobalErrors: true,

  // Queue events when offline, send when back online
  enableOfflineQueue: true,
  maxOfflineQueueSize: 200,

  // Batch to reduce network calls
  enableBatching: true,
  batchInterval: 5000,
  batchSize: 15,

  // Don't send DEBUG logs from frontend
  minLevel: "INFO",

  sanitize: true,
  sensitiveFields: ["password", "token", "creditCard", "cvv"],

  globalMetadata: {
    platform: "web",
    browser: navigator.userAgent,
    screenResolution: `${window.screen.width}x${window.screen.height}`,
    language: navigator.language,
  },

  debug: import.meta.env.DEV,
});

export default LogVault;
