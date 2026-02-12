import { Metadata } from "../types";

const DEFAULT_SENSITIVE_FIELDS = [
  "password",
  "passwd",
  "secret",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiKey",
  "api_key",
  "apiSecret",
  "api_secret",
  "authorization",
  "cookie",
  "creditCard",
  "credit_card",
  "cardNumber",
  "card_number",
  "cvv",
  "ssn",
  "social_security",
  "privateKey",
  "private_key",
];

export class Sanitizer {
  private sensitiveFields: Set<string>;

  constructor(customFields: string[] = []) {
    this.sensitiveFields = new Set([
      ...DEFAULT_SENSITIVE_FIELDS.map((f) => f.toLowerCase()),
      ...customFields.map((f) => f.toLowerCase()),
    ]);
  }

  sanitize(data: unknown, depth = 0): unknown {
    if (depth > 10) return "[MAX_DEPTH]";

    if (data === null || data === undefined) return data;
    if (typeof data === "string") return data;
    if (typeof data === "number" || typeof data === "boolean") return data;

    if (Array.isArray(data)) {
      return data.map((item) => this.sanitize(item, depth + 1));
    }

    if (typeof data === "object") {
      const sanitized: Metadata = {};

      for (const [key, value] of Object.entries(data)) {
        if (this.sensitiveFields.has(key.toLowerCase())) {
          sanitized[key] = "[REDACTED]";
        } else {
          sanitized[key] = this.sanitize(value, depth + 1);
        }
      }

      return sanitized;
    }

    return String(data);
  }

  sanitizeMetadata(metadata: Metadata | undefined): Metadata | undefined {
    if (!metadata) return metadata;
    return this.sanitize(metadata) as Metadata;
  }
}
