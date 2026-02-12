// src/index.ts

// ============================================================================
// IMPORTS (do użycia w tym pliku)
// ============================================================================

import { LunorClient } from "./client";
import type { LunorConfig } from "./types";
import { LogLevel, ErrorType, Severity, SecurityType } from "./types";

// ============================================================================
// RE-EXPORTS (dla konsumentów SDK)
// ============================================================================

export { LunorClient } from "./client";
export { LogLevel, ErrorType, Severity, SecurityType } from "./types";

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
// FACTORY FUNCTION
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
 * Get the global singleton instance (throws if not initialized)
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
// DEFAULT EXPORT
// ============================================================================

// ✅ Teraz LogLevel, ErrorType, Severity, SecurityType istnieją w scope
//    dzięki importowi na górze pliku
export default {
  init,
  getInstance,
  destroy,
  createLunorClient,
  LunorClient,
  LogLevel,
  ErrorType,
  Severity,
  SecurityType,
};
