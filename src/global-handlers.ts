// src/global-handlers.ts

import type { LunorClient } from "./client";
import { ErrorType, Severity, LogLevel } from "./types";
import { isBrowser, isNode } from "./utils";
import { scrubSensitive, scrubString } from "./scrubber";

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
        message: scrubString(event.message || "Uncaught error"),
        stack: scrubString(
          event.error?.stack ||
            `${event.filename}:${event.lineno}:${event.colno}`,
        ),
        severity: Severity.HIGH,
        metadata: scrubSensitive({
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          autoCapture: true,
        }) as Record<string, unknown>,
      });
    };

    window.addEventListener("error", handler);
    return () => window.removeEventListener("error", handler);
  }

  if (isNode()) {
    const handler = (error: Error) => {
      client.captureError({
        type: ErrorType.RUNTIME,
        message: scrubString(error.message || "Uncaught exception"),
        stack: error.stack ? scrubString(error.stack) : undefined,
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
        message: scrubString(`Unhandled Promise Rejection: ${message}`),
        stack: stack ? scrubString(stack) : undefined,
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
        message: scrubString(`Unhandled Promise Rejection: ${message}`),
        stack: stack ? scrubString(stack) : undefined,
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
        // Call original console method with the ORIGINAL, unscrubbed args —
        // the developer must still see real data in their devtools.
        original.apply(console, args);

        // For the event sent to Lunor, scrub every argument first so we
        // never ship tokens, passwords, emails, or similar PII upstream.
        try {
          const scrubbedArgs = args.map((arg) => scrubSensitive(arg));
          const message = scrubbedArgs
            .map((arg) =>
              typeof arg === "object" && arg !== null
                ? JSON.stringify(arg)
                : String(arg),
            )
            .join(" ");

          client.log({
            level: levelMap[level] || LogLevel.INFO,
            message: scrubString(message),
            metadata: { autoCapture: true, consoleLevel: level },
          });
        } catch {
          // Never let console capture break the host app.
        }
      };
    }
  }

  return () => {
    for (const [level, original] of Object.entries(originalMethods)) {
      (console as unknown as Record<string, unknown>)[level] = original;
    }
  };
}
