// src/retry.ts

import { sleep } from "./utils";

export interface RetryOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Execute a function with exponential backoff retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < options.maxRetries) {
        const delay = calculateBackoff(
          attempt,
          options.baseDelay,
          options.maxDelay,
        );
        options.onRetry?.(attempt + 1, lastError);
        await sleep(delay);
      }
    }
  }

  throw lastError!;
}

/**
 * Calculate delay using exponential backoff with jitter
 */
function calculateBackoff(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelay;
  return Math.min(exponentialDelay + jitter, maxDelay);
}
