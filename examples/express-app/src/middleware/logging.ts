import { Request, Response, NextFunction } from "express";
import LogVault from "../LogVault";
import { randomUUID } from "crypto";

/**
 * Middleware: Attach request context + log requests/responses
 */
export function requestLogger() {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers["x-request-id"] as string) || randomUUID();
    const startTime = Date.now();

    // Attach request ID to response headers
    res.setHeader("X-Request-Id", requestId);

    // Push scope for this request
    LogVault.pushScope({
      requestId,
      extra: {
        method: req.method,
        path: req.path,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      },
    });

    // Log incoming request
    LogVault.info(`${req.method} ${req.path}`, {
      query: req.query,
      params: req.params,
      contentLength: req.headers["content-length"],
    });

    // Capture response
    const originalEnd = res.end;
    res.end = function (...args: Parameters<Response["end"]>) {
      const duration = Date.now() - startTime;

      // Log response
      LogVault.log(`${req.method} ${req.path} → ${res.statusCode}`, {
        level:
          res.statusCode >= 500
            ? "ERROR"
            : res.statusCode >= 400
              ? "WARN"
              : "INFO",
        metadata: {
          statusCode: res.statusCode,
          duration: `${duration}ms`,
          contentLength: res.getHeader("content-length"),
        },
      });

      // Send performance data for slow requests
      if (duration > 1000) {
        LogVault.debug({
          type: "slow_request",
          data: {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
          },
          performance: {
            durationMs: duration,
            threshold: 1000,
          },
        });
      }

      // Pop scope
      LogVault.popScope();

      return originalEnd.apply(res, args);
    } as typeof res.end;

    next();
  };
}

/**
 * Middleware: Error handler with LogVault error reporting
 */
export function errorHandler() {
  return (err: Error, req: Request, res: Response, _next: NextFunction) => {
    // Capture the exception
    LogVault.captureException(err, {
      severity: res.statusCode >= 500 ? "HIGH" : "MEDIUM",
      metadata: {
        method: req.method,
        path: req.path,
        query: req.query,
        body: req.body, // Sanitizer will redact sensitive fields
        ip: req.ip,
        userId: (req as Record<string, unknown>).userId,
      },
    });

    // Send response
    const statusCode = res.statusCode !== 200 ? res.statusCode : 500;
    res.status(statusCode).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : err.message,
      requestId: res.getHeader("X-Request-Id"),
    });
  };
}
