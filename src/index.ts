import { LogVaultClient } from "./client";
import { LogVaultConfig } from "./types";

export { LogVaultClient } from "./client";
export * from "./types";
export { PerformanceMonitor } from "./interceptors/performance";
export { Sanitizer } from "./utils/sanitizer";

// ============================================================
// Singleton — for simple single-project setups
// ============================================================

let defaultClient: LogVaultClient | null = null;

/**
 * Initialize the default LogVault client (singleton)
 */
export function init(config: LogVaultConfig): LogVaultClient {
  if (defaultClient) {
    console.warn(
      "[LogVault] Client already initialized — destroying previous instance",
    );
    defaultClient.destroy();
  }

  defaultClient = new LogVaultClient(config);
  return defaultClient;
}

/**
 * Get the default client instance
 */
export function getClient(): LogVaultClient {
  if (!defaultClient) {
    throw new Error("[LogVault] Client not initialized. Call init() first.");
  }
  return defaultClient;
}

// ============================================================
// Convenience exports that use the default client
// ============================================================

export const log = (...args: Parameters<LogVaultClient["log"]>) =>
  getClient().log(...args);
export const info = (...args: Parameters<LogVaultClient["info"]>) =>
  getClient().info(...args);
export const warn = (...args: Parameters<LogVaultClient["warn"]>) =>
  getClient().warn(...args);
export const error = (...args: Parameters<LogVaultClient["error"]>) =>
  getClient().error(...args);
export const fatal = (...args: Parameters<LogVaultClient["fatal"]>) =>
  getClient().fatal(...args);
export const trace = (...args: Parameters<LogVaultClient["trace"]>) =>
  getClient().trace(...args);
export const captureException = (
  ...args: Parameters<LogVaultClient["captureException"]>
) => getClient().captureException(...args);
export const debug = (...args: Parameters<LogVaultClient["debug"]>) =>
  getClient().debug(...args);
export const security = (...args: Parameters<LogVaultClient["security"]>) =>
  getClient().security(...args);
export const setContext = (...args: Parameters<LogVaultClient["setContext"]>) =>
  getClient().setContext(...args);
export const setUser = (...args: Parameters<LogVaultClient["setUser"]>) =>
  getClient().setUser(...args);
export const flush = () => getClient().flush();
export const destroy = () => getClient().destroy();
