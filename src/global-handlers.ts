// src/global-handlers.ts

import type { LunorClient } from "./client";
import { ErrorType, Severity, LogLevel } from "./types";
import { isBrowser, isNode } from "./utils";

interface ErrorHandlerCleanup {
  uninstall: () => void;
}

/**
 * Install global error handlers (browser + Node.js)
 */
export function installGlobalHandlers(
  client: LunorClient,
  options: {
    captureErrors: boolean;
    captureRejections: boolean;
    captureConsole: boolean;
    consoleLevels: string[];
  },
): ErrorHandlerCleanup {
  const cleanups: (() => void)[] = [];

  if (options.captureErrors) {
    cleanups.push(installErrorHandler(client));
  }

  if (options.captureRejections) {
    cleanups.push(installRejectionHandler(client));
  }

  if (options.captureConsole) {
    cleanups.push(installConsoleCapture(client, options.consoleLevels));
  }

  return {
    uninstall: () => {
      cleanups.forEach((cleanup) => cleanup());
    },
  };
}

function installErrorHandler(client: LunorClient): () => void {
  if (isBrowser()) {
    const handler = (event: ErrorEvent) => {
      client.captureError({
        type: ErrorType.RUNTIME,
        message: event.message || "Uncaught error",
        stack:
          event.error?.stack ||
          `${event.filename}:${event.lineno}:${event.colno}`,
        severity: Severity.HIGH,
        metadata: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          autoCapture: true,
        },
      });
    };

    window.addEventListener("error", handler);
    return () => window.removeEventListener("error", handler);
  }

  if (isNode()) {
    const handler = (error: Error) => {
      client.captureError({
        type: ErrorType.RUNTIME,
        message: error.message || "Uncaught exception",
        stack: error.stack,
        severity: Severity.CRITICAL,
        metadata: {
          name: error.name,
          autoCapture: true,
        },
      });

      // Force flush and re-throw so node still crashes
      client.forceFlush().finally(() => {
        process.exit(1);
      });
    };

    process.on("uncaughtException", handler);
    return () => process.removeListener("uncaughtException", handler);
  }

  return () => {};
}

function installRejectionHandler(client: LunorClient): () => void {
  if (isBrowser()) {
    const handler = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : String(reason ?? "Unhandled rejection");
      const stack = reason instanceof Error ? reason.stack : undefined;

      client.captureError({
        type: ErrorType.RUNTIME,
        message: `Unhandled Promise Rejection: ${message}`,
        stack,
        severity: Severity.HIGH,
        metadata: { autoCapture: true, type: "unhandledRejection" },
      });
    };

    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }

  if (isNode()) {
    const handler = (reason: unknown) => {
      const message =
        reason instanceof Error
          ? reason.message
          : String(reason ?? "Unhandled rejection");
      const stack =
        reason instanceof Error ? (reason as Error).stack : undefined;

      client.captureError({
        type: ErrorType.RUNTIME,
        message: `Unhandled Promise Rejection: ${message}`,
        stack,
        severity: Severity.HIGH,
        metadata: { autoCapture: true, type: "unhandledRejection" },
      });
    };

    process.on("unhandledRejection", handler);
    return () => process.removeListener("unhandledRejection", handler);
  }

  return () => {};
}

function installConsoleCapture(
  client: LunorClient,
  levels: string[],
): () => void {
  const originalMethods: Record<string, (...args: unknown[]) => void> = {};

  // ✅ Mapowanie na wartości enum LogLevel zamiast stringów
  const levelMap: Record<string, LogLevel> = {
    error: LogLevel.ERROR,
    warn: LogLevel.WARN,
    log: LogLevel.INFO,
    debug: LogLevel.DEBUG,
  };

  for (const level of levels) {
    if (level in console) {
      const original = (console as unknown as Record<string, unknown>)[
        level
      ] as (...args: unknown[]) => void;
      originalMethods[level] = original;

      (console as unknown as Record<string, unknown>)[level] = (
        ...args: unknown[]
      ) => {
        // Call original console method
        original.apply(console, args);

        // Send to Lunor
        const message = args
          .map((arg) =>
            typeof arg === "object" ? JSON.stringify(arg) : String(arg),
          )
          .join(" ");

        // ✅ Teraz levelMap zwraca LogLevel enum — żaden cast nie jest potrzebny
        client.log({
          level: levelMap[level] || LogLevel.INFO,
          message,
          metadata: { autoCapture: true, consoleLevel: level },
        });
      };
    }
  }

  return () => {
    for (const [level, original] of Object.entries(originalMethods)) {
      (console as unknown as Record<string, unknown>)[level] = original;
    }
  };
}
