// src/index.ts

// ============================================================================
// IMPORTS
// ============================================================================

import { LunorClient } from "./client";
import type { LunorConfig } from "./types";
import { LogLevel, ErrorType, Severity, SecurityType } from "./types";

// ============================================================================
// RE-EXPORTS
// ============================================================================

export { LunorClient } from "./client";
export { LogLevel, ErrorType, Severity, SecurityType } from "./types";
export { scrubSensitive, scrubString, maskEmail } from "./scrubber";

export type {
  LunorConfig,
  LogPayload,
  ErrorPayload,
  DebugPayload,
  SecurityPayload,
  WebhookPayload,
  MiddlewareFn,
  PerformanceMark,
  ContextData,
  TransportResponse,
} from "./types";

// ============================================================================
// SINGLETON
// ============================================================================

let _instance: LunorClient | null = null;

/**
 * Create a new Lunor client instance
 */
export function createLunorClient(config: LunorConfig): LunorClient {
  return new LunorClient(config);
}

/**
 * Initialize the global singleton instance
 */
export function init(config: LunorConfig): LunorClient {
  if (_instance) {
    console.warn(
      "[Lunor] SDK already initialized. Call destroy() first to re-initialize.",
    );
    return _instance;
  }

  _instance = new LunorClient(config);
  return _instance;
}

/**
 * Get the global singleton instance
 */
export function getInstance(): LunorClient {
  if (!_instance) {
    throw new Error("[Lunor] SDK not initialized. Call init() first.");
  }
  return _instance;
}

/**
 * Destroy the global singleton instance
 */
export async function destroy(): Promise<void> {
  if (_instance) {
    await _instance.destroy();
    _instance = null;
  }
}

// ============================================================================
// ✅ NAMESPACE EXPORT zamiast default — działa z CJS i ESM bez warningów
// ============================================================================

export const Lunor = {
  init,
  getInstance,
  destroy,
  createLunorClient,
  LunorClient,
  LogLevel,
  ErrorType,
  Severity,
  SecurityType,
} as const;
