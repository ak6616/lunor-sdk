// src/constants.ts

import { LogLevel, type LunorConfig } from "./types";

export const SDK_VERSION = "2.0.0";
export const SDK_NAME = "lunor-sdk";

// Twój prywatny endpoint — hardcoded, nie do nadpisania przez klientów
export const LUNOR_ENDPOINT = "https://www.lunor.com.pl/api/webhook";

export const DEFAULT_CONFIG: Required<
  Pick<
    LunorConfig,
    | "endpoint"
    | "batchSize"
    | "flushInterval"
    | "maxRetries"
    | "retryBaseDelay"
    | "retryMaxDelay"
    | "timeout"
    | "captureGlobalErrors"
    | "captureUnhandledRejections"
    | "captureConsole"
    | "captureConsoleLevels"
    | "enablePersistence"
    | "persistencePrefix"
    | "maxQueueSize"
    | "minLogLevel"
    | "debug"
    | "defaultSource"
    | "environment"
    | "sampleRate"
    | "enablePerformance"
  >
> = {
  // Endpoint jest stały — zawsze Twój serwer
  endpoint: LUNOR_ENDPOINT,
  batchSize: 10,
  flushInterval: 5000,
  maxRetries: 3,
  retryBaseDelay: 1000,
  retryMaxDelay: 30000,
  timeout: 10000,
  captureGlobalErrors: true,
  captureUnhandledRejections: true,
  captureConsole: false,
  captureConsoleLevels: ["error", "warn"],
  enablePersistence: true,
  persistencePrefix: "__lunor_",
  maxQueueSize: 1000,
  minLogLevel: LogLevel.DEBUG,
  debug: false,
  defaultSource: "app",
  environment: "production",
  sampleRate: 1.0,
  enablePerformance: false,
};

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
  [LogLevel.FATAL]: 4,
};

export const HEADER_API_KEY = "X-API-Key";
/**
 * @deprecated Since SDK v2.1 the apiSecret is NEVER transmitted. It is used
 * only locally as an HMAC signing key. This constant is retained for backwards
 * compatibility of existing imports but MUST NOT be added to any request.
 */
export const HEADER_API_SECRET = "X-API-Secret";
export const HEADER_LUNOR_SIGNATURE = "X-Lunor-Signature";
export const HEADER_LUNOR_TIMESTAMP = "X-Lunor-Timestamp";
