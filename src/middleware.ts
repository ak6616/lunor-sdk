// src/middleware.ts

import type { MiddlewareFn, WebhookPayload } from "./types";

export class MiddlewareChain {
  private middlewares: MiddlewareFn[] = [];

  /**
   * Add a middleware function
   */
  use(fn: MiddlewareFn): void {
    this.middlewares.push(fn);
  }

  /**
   * Execute the middleware chain on a payload.
   * Each middleware can modify the payload or stop the chain.
   * Returns the (possibly modified) payload, or null if dropped.
   */
  async execute(payload: WebhookPayload): Promise<WebhookPayload | null> {
    let currentPayload = payload;
    let dropped = false;

    for (const middleware of this.middlewares) {
      if (dropped) break;

      let nextCalled = false;

      await middleware(currentPayload, () => {
        nextCalled = true;
      });

      if (!nextCalled) {
        dropped = true;
      }
    }

    return dropped ? null : currentPayload;
  }

  /**
   * Get the number of registered middlewares
   */
  get count(): number {
    return this.middlewares.length;
  }

  /**
   * Clear all middlewares
   */
  clear(): void {
    this.middlewares = [];
  }
}
