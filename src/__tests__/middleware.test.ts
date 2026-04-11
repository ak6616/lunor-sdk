import { describe, it, expect, vi } from "vitest";
import { MiddlewareChain } from "../middleware";
import type { WebhookPayload } from "../types";

function makePayload(): WebhookPayload {
  return { type: "log", data: { message: "test" } as never };
}

describe("MiddlewareChain", () => {
  describe("use / count / clear", () => {
    it("starts with no middlewares", () => {
      const chain = new MiddlewareChain();
      expect(chain.count).toBe(0);
    });

    it("increments count when middleware is added", () => {
      const chain = new MiddlewareChain();
      chain.use((_p, next) => { next(); });
      expect(chain.count).toBe(1);
    });

    it("clear removes all middlewares", () => {
      const chain = new MiddlewareChain();
      chain.use((_p, next) => { next(); });
      chain.clear();
      expect(chain.count).toBe(0);
    });
  });

  describe("execute — pass-through", () => {
    it("returns payload unchanged when no middlewares registered", async () => {
      const chain = new MiddlewareChain();
      const payload = makePayload();
      const result = await chain.execute(payload);
      expect(result).toBe(payload);
    });

    it("passes through when all middlewares call next()", async () => {
      const chain = new MiddlewareChain();
      chain.use((_p, next) => { next(); });
      chain.use((_p, next) => { next(); });

      const payload = makePayload();
      const result = await chain.execute(payload);
      expect(result).toBe(payload);
    });
  });

  describe("execute — dropping", () => {
    it("returns null when middleware does not call next()", async () => {
      const chain = new MiddlewareChain();
      chain.use((_p, _next) => { /* does not call next */ });

      const result = await chain.execute(makePayload());
      expect(result).toBeNull();
    });

    it("stops chain execution after a middleware drops the event", async () => {
      const chain = new MiddlewareChain();
      const second = vi.fn((_p: WebhookPayload, next: () => void) => { next(); });

      chain.use((_p, _next) => { /* drop */ });
      chain.use(second);

      await chain.execute(makePayload());
      expect(second).not.toHaveBeenCalled();
    });

    it("returns null when first of three middlewares drops", async () => {
      const chain = new MiddlewareChain();
      chain.use((_p, _next) => { /* drop */ });
      chain.use((_p, next) => { next(); });
      chain.use((_p, next) => { next(); });

      expect(await chain.execute(makePayload())).toBeNull();
    });
  });

  describe("execute — async middleware", () => {
    it("handles async middlewares that call next()", async () => {
      const chain = new MiddlewareChain();
      chain.use(async (_p, next) => {
        await Promise.resolve();
        next();
      });

      const payload = makePayload();
      const result = await chain.execute(payload);
      expect(result).toBe(payload);
    });

    it("handles async middleware that drops", async () => {
      const chain = new MiddlewareChain();
      chain.use(async (_p, _next) => {
        await Promise.resolve();
        // does not call next
      });

      expect(await chain.execute(makePayload())).toBeNull();
    });
  });

  describe("execute — middleware ordering", () => {
    it("runs middlewares in registration order", async () => {
      const order: number[] = [];
      const chain = new MiddlewareChain();
      chain.use((_p, next) => { order.push(1); next(); });
      chain.use((_p, next) => { order.push(2); next(); });
      chain.use((_p, next) => { order.push(3); next(); });

      await chain.execute(makePayload());
      expect(order).toEqual([1, 2, 3]);
    });

    it("passes the same payload instance through the chain", async () => {
      const chain = new MiddlewareChain();
      const seen: WebhookPayload[] = [];

      chain.use((p, next) => { seen.push(p); next(); });
      chain.use((p, next) => { seen.push(p); next(); });

      const payload = makePayload();
      await chain.execute(payload);

      expect(seen[0]).toBe(payload);
      expect(seen[1]).toBe(payload);
    });
  });
});
