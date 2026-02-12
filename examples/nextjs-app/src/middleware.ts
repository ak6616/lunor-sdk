import { NextRequest, NextResponse } from "next/server";
import { getLogVault } from "@/lib/LogVault";

const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS = 100;
const requestCounts = new Map<string, { count: number; windowStart: number }>();

export function middleware(req: NextRequest) {
  const LogVault = getLogVault();
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const userAgent = req.headers.get("user-agent") || "unknown";
  const pathname = req.nextUrl.pathname;

  // ============================================================
  // Rate Limiting with Security Reporting
  // ============================================================
  if (pathname.startsWith("/api/")) {
    const now = Date.now();
    const record = requestCounts.get(ip);

    if (record && now - record.windowStart < RATE_LIMIT_WINDOW) {
      record.count++;

      if (record.count > MAX_REQUESTS) {
        // Report rate limit breach
        LogVault.security({
          type: "RATE_LIMIT",
          description: `Rate limit exceeded: ${record.count} requests in ${RATE_LIMIT_WINDOW / 1000}s from ${ip}`,
          ipAddress: ip,
          userAgent,
          metadata: {
            path: pathname,
            requestCount: record.count,
            window: RATE_LIMIT_WINDOW,
            limit: MAX_REQUESTS,
          },
        });

        return NextResponse.json(
          { error: "Too many requests" },
          { status: 429, headers: { "Retry-After": "60" } },
        );
      }
    } else {
      requestCounts.set(ip, { count: 1, windowStart: now });
    }
  }

  // ============================================================
  // Suspicious Path Detection
  // ============================================================
  const suspiciousPaths = [
    "/wp-admin",
    "/wp-login",
    "/.env",
    "/phpmyadmin",
    "/admin.php",
    "/.git",
    "/etc/passwd",
    "/actuator",
    "/debug/pprof",
  ];

  if (suspiciousPaths.some((p) => pathname.toLowerCase().includes(p))) {
    LogVault.security({
      type: "SUSPICIOUS_ACTIVITY",
      description: `Suspicious path access attempt: ${pathname}`,
      ipAddress: ip,
      userAgent,
      metadata: { path: pathname, method: req.method },
    });

    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
