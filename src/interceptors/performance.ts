import type { LogVaultClient } from "../client";
import { PerformanceEntry } from "../types";

export class PerformanceMonitor {
  private entries: Map<string, PerformanceEntry> = new Map();

  constructor(private client: LogVaultClient) {}

  startTimer(name: string, metadata?: Record<string, unknown>): () => void {
    const entry: PerformanceEntry = {
      name,
      startTime: Date.now(),
      metadata,
    };

    this.entries.set(name, entry);

    // Return a stop function
    return () => this.stopTimer(name);
  }

  stopTimer(name: string): PerformanceEntry | null {
    const entry = this.entries.get(name);
    if (!entry) return null;

    entry.endTime = Date.now();
    entry.duration = entry.endTime - entry.startTime;
    this.entries.delete(name);

    // Send as debug event
    this.client.debug({
      type: "performance",
      data: {
        name: entry.name,
        duration: entry.duration,
        ...entry.metadata,
      },
      performance: {
        startTime: entry.startTime,
        endTime: entry.endTime,
        durationMs: entry.duration,
      },
    });

    return entry;
  }

  /**
   * Measure an async operation
   */
  async measure<T>(
    name: string,
    fn: () => Promise<T>,
    metadata?: Record<string, unknown>,
  ): Promise<T> {
    const stop = this.startTimer(name, metadata);
    try {
      return await fn();
    } finally {
      stop();
    }
  }

  /**
   * Wrap a function with automatic performance tracking
   */
  wrap<T extends (...args: unknown[]) => unknown>(name: string, fn: T): T {
    const self = this;
    return function (this: unknown, ...args: unknown[]) {
      const stop = self.startTimer(name, { argCount: args.length });
      try {
        const result = fn.apply(this, args);
        if (result instanceof Promise) {
          return result.finally(() => stop());
        }
        stop();
        return result;
      } catch (error) {
        stop();
        throw error;
      }
    } as T;
  }
}
