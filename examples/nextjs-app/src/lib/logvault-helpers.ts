import { NextRequest, NextResponse } from "next/server";
import { getLogVault } from "./LogVault";
import { Severity, Metadata } from "@LogVault/sdk";

/**
 * Higher-order wrapper for Next.js API route handlers
 * Provides automatic logging, error capturing, and performance tracking.
 */
export function withLogVault(
  handler: (
    req: NextRequest,
    context?: Record<string, unknown>,
  ) => Promise<NextResponse>,
  options: {
    name?: string;
    metadata?: Metadata;
  } = {},
) {
  return async (
    req: NextRequest,
    context?: Record<string, unknown>,
  ): Promise<NextResponse> => {
    const LogVault = getLogVault();
    const startTime = Date.now();
    const requestId = req.headers.get("x-request-id") || crypto.randomUUID();
    const routeName = options.name || `${req.method} ${req.nextUrl.pathname}`;

    // Push request scope
    LogVault.pushScope({
      requestId,
      extra: {
        method: req.method,
        pathname: req.nextUrl.pathname,
        ...options.metadata,
      },
    });

    try {
      // Log incoming request
      LogVault.info(`→ ${routeName}`, {
        searchParams: Object.fromEntries(req.nextUrl.searchParams),
      });

      // Execute handler
      const response = await handler(req, context);
      const duration = Date.now() - startTime;

      // Log response
      LogVault.info(`← ${routeName} [${response.status}] ${duration}ms`, {
        statusCode: response.status,
        duration,
      });

      // Track slow endpoints
      if (duration > 2000) {
        LogVault.debug({
          type: "slow_endpoint",
          data: { route: routeName, statusCode: response.status },
          performance: { durationMs: duration, threshold: 2000 },
        });
      }

      // Attach request ID to response
      response.headers.set("X-Request-Id", requestId);

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      const err = error instanceof Error ? error : new Error(String(error));

      // Determine severity
      let severity: Severity = "HIGH";
      if (err.message.includes("not found") || err.message.includes("404")) {
        severity = "LOW";
      } else if (err.message.includes("timeout")) {
        severity = "MEDIUM";
      }

      // Capture exception
      await LogVault.captureException(err, {
        severity,
        metadata: {
          route: routeName,
          duration,
          requestId,
        },
      });

      // Return error response
      return NextResponse.json(
        {
          error:
            process.env.NODE_ENV === "production"
              ? "Internal server error"
              : err.message,
          requestId,
        },
        { status: 500 },
      );
    } finally {
      LogVault.popScope();
    }
  };
}
