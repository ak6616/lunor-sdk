import type { LogVaultClient } from "../client";

export function setupGlobalErrorHandler(client: LogVaultClient): () => void {
  // Node.js environment
  if (typeof process !== "undefined" && process.on) {
    const uncaughtHandler = (error: Error) => {
      client.captureException(error, {
        severity: "CRITICAL",
        metadata: { handler: "uncaughtException" },
      });
    };

    const rejectionHandler = (reason: unknown) => {
      const error =
        reason instanceof Error ? reason : new Error(String(reason));
      client.captureException(error, {
        severity: "HIGH",
        metadata: { handler: "unhandledRejection" },
      });
    };

    process.on("uncaughtException", uncaughtHandler);
    process.on("unhandledRejection", rejectionHandler);

    return () => {
      process.removeListener("uncaughtException", uncaughtHandler);
      process.removeListener("unhandledRejection", rejectionHandler);
    };
  }

  // Browser environment
  if (typeof window !== "undefined") {
    const errorHandler = (event: ErrorEvent) => {
      client.captureException(event.error || new Error(event.message), {
        severity: "HIGH",
        metadata: {
          handler: "window.onerror",
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      });
    };

    const rejectionHandler = (event: PromiseRejectionEvent) => {
      const error =
        event.reason instanceof Error
          ? event.reason
          : new Error(String(event.reason));
      client.captureException(error, {
        severity: "HIGH",
        metadata: { handler: "unhandledrejection" },
      });
    };

    window.addEventListener("error", errorHandler);
    window.addEventListener("unhandledrejection", rejectionHandler);

    return () => {
      window.removeEventListener("error", errorHandler);
      window.removeEventListener("unhandledrejection", rejectionHandler);
    };
  }

  return () => {};
}
