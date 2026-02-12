// src/utils.ts

import { SDK_NAME } from "./constants";

/**
 * Generate a unique ID
 */
export function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Get current ISO timestamp
 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Safe JSON stringify with circular reference handling
 */
export function safeStringify(obj: unknown, maxDepth = 10): string {
  const seen = new WeakSet();
  let depth = 0;

  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value) || depth > maxDepth) return "[Circular]";
      seen.add(value);
      depth++;
    }
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
    return value;
  });
}

/**
 * Safe JSON parse
 */
export function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Internal logger (only logs when debug mode is on)
 */
export function createInternalLogger(debug: boolean) {
  const prefix = `[${SDK_NAME}]`;

  return {
    debug: (...args: unknown[]) => {
      if (debug) console.debug(prefix, ...args);
    },
    info: (...args: unknown[]) => {
      if (debug) console.info(prefix, ...args);
    },
    warn: (...args: unknown[]) => {
      console.warn(prefix, ...args);
    },
    error: (...args: unknown[]) => {
      console.error(prefix, ...args);
    },
  };
}

/**
 * Detect runtime environment
 */
export function detectRuntime(): "browser" | "node" | "edge" | "unknown" {
  if (typeof window !== "undefined" && typeof document !== "undefined")
    return "browser";
  if (typeof process !== "undefined" && process.versions?.node) return "node";
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as Record<string, unknown>).EdgeRuntime === "string"
  )
    return "edge";
  return "unknown";
}

/**
 * Check if the current environment is a browser
 */
export function isBrowser(): boolean {
  return detectRuntime() === "browser";
}

/**
 * Check if the current environment is Node.js
 */
export function isNode(): boolean {
  return detectRuntime() === "node";
}

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract stack trace from an Error
 */
export function extractStack(error: Error): string {
  return error.stack || `${error.name}: ${error.message}`;
}

/**
 * Truncate a string to a maximum length
 */
export function truncate(str: string, maxLength = 10000): string {
  if (str.length <= maxLength) return str;
  return (
    str.substring(0, maxLength) + `... [truncated, total ${str.length} chars]`
  );
}

/**
 * Deep merge two objects
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target };

  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceVal = source[key];
    const targetVal = result[key];

    if (
      sourceVal &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal as T[keyof T];
    }
  }

  return result;
}
