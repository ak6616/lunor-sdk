import type { LogVaultClient } from "../client";
import { LogLevel } from "../types";

const CONSOLE_LEVEL_MAP: Record<string, LogLevel> = {
  debug: "DEBUG",
  log: "INFO",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

export function setupConsoleInterceptor(client: LogVaultClient): () => void {
  const original = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  for (const [method, level] of Object.entries(CONSOLE_LEVEL_MAP)) {
    const originalFn = original[method as keyof typeof original];

    (console as Record<string, unknown>)[method] = (...args: unknown[]) => {
      // Always call original
      originalFn.apply(console, args);

      // Send to LogVault
      const message = args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ");

      client.log(message, {
        level,
        source: "console",
        metadata: { method, argCount: args.length },
      });
    };
  }

  // Restore
  return () => {
    Object.assign(console, original);
  };
}
