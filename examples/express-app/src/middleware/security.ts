import { Request, Response, NextFunction } from "express";
import LogVault from "../LogVault";

const failedAttempts = new Map<
  string,
  { count: number; firstAttempt: number }
>();

/**
 * Detect and report suspicious security events
 */
export function securityMonitor() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const userAgent = req.headers["user-agent"] || "unknown";

    // ---- SQL Injection Detection ----
    const suspiciousPatterns = [
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER)\b.*\b(FROM|INTO|TABLE|SET)\b)/i,
      /(-{2}|\/\*|\*\/|;.*--)/,
      /(OR|AND)\s+[\d]+=[\d]+/i,
    ];

    const allInput = JSON.stringify({
      ...req.query,
      ...req.body,
      ...req.params,
    });

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(allInput)) {
        LogVault.security({
          type: "SQL_INJECTION",
          description: `Possible SQL injection attempt detected from ${ip}`,
          ipAddress: ip,
          userAgent,
          metadata: {
            path: req.path,
            method: req.method,
            matchedPattern: pattern.toString(),
          },
        });
        break;
      }
    }

    // ---- XSS Detection ----
    const xssPatterns = [
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i,
      /on\w+\s*=\s*["']?[^"']*["']?/i,
      /javascript\s*:/i,
    ];

    for (const pattern of xssPatterns) {
      if (pattern.test(allInput)) {
        LogVault.security({
          type: "XSS_ATTEMPT",
          description: `Possible XSS attempt detected from ${ip}`,
          ipAddress: ip,
          userAgent,
          metadata: {
            path: req.path,
            method: req.method,
          },
        });
        break;
      }
    }

    next();
  };
}

/**
 * Report brute-force login attempts
 */
export function bruteForceDetector(
  options: { maxAttempts?: number; windowMs?: number } = {},
) {
  const { maxAttempts = 5, windowMs = 15 * 60 * 1000 } = options;

  return {
    recordFailedAttempt(ip: string, userAgent: string, path: string) {
      const now = Date.now();
      const record = failedAttempts.get(ip);

      if (record && now - record.firstAttempt < windowMs) {
        record.count++;

        if (record.count >= maxAttempts) {
          LogVault.security({
            type: "BRUTE_FORCE",
            description: `Brute force attack detected: ${record.count} failed attempts from ${ip}`,
            ipAddress: ip,
            userAgent,
            metadata: {
              failedAttempts: record.count,
              windowMs,
              path,
            },
          });

          failedAttempts.delete(ip);
        }
      } else {
        failedAttempts.set(ip, { count: 1, firstAttempt: now });
      }
    },

    recordSuccessfulAttempt(ip: string) {
      failedAttempts.delete(ip);
    },
  };
}
