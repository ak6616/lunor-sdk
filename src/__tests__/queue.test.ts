import { describe, it, expect, vi, beforeEach } from "vitest";
import { PersistentQueue } from "../queue";
import type { WebhookPayload } from "../types";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makePayload(type: "log" | "error" = "log"): WebhookPayload {
  return { type, data: { message: "test" } as never };
}

describe("PersistentQueue", () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    logger = makeLogger();
  });

  describe("basic enqueue / dequeue", () => {
    it("enqueues and dequeues items in FIFO order", () => {
      const q = new PersistentQueue(10, "key", false, logger);
      const p1 = makePayload();
      const p2 = makePayload("error");
      q.enqueue(p1);
      q.enqueue(p2);

      const items = q.dequeue(2);
      expect(items).toHaveLength(2);
      expect(items[0].payload).toBe(p1);
      expect(items[1].payload).toBe(p2);
    });

    it("dequeue returns fewer items when queue has less than requested", () => {
      const q = new PersistentQueue(10, "key", false, logger);
      q.enqueue(makePayload());
      const items = q.dequeue(5);
      expect(items).toHaveLength(1);
    });

    it("dequeue returns empty array when queue is empty", () => {
      const q = new PersistentQueue(10, "key", false, logger);
      expect(q.dequeue(5)).toEqual([]);
    });

    it("assigns an id to each enqueued item", () => {
      const q = new PersistentQueue(10, "key", false, logger);
      q.enqueue(makePayload());
      const [item] = q.dequeue(1);
      expect(item.id).toBeTruthy();
    });

    it("initialises retries to 0", () => {
      const q = new PersistentQueue(10, "key", false, logger);
      q.enqueue(makePayload());
      const [item] = q.dequeue(1);
      expect(item.retries).toBe(0);
    });
  });

  describe("max-size eviction", () => {
    it("drops the oldest item when queue is full", () => {
      const q = new PersistentQueue(2, "key", false, logger);
      const p1 = makePayload();
      const p2 = makePayload();
      const p3 = makePayload("error");
      q.enqueue(p1);
      q.enqueue(p2);
      q.enqueue(p3); // should evict p1

      expect(q.size).toBe(2);
      const items = q.dequeue(2);
      expect(items[0].payload).toBe(p2);
      expect(items[1].payload).toBe(p3);
    });

    it("logs a warning on eviction", () => {
      const q = new PersistentQueue(1, "key", false, logger);
      q.enqueue(makePayload());
      q.enqueue(makePayload()); // triggers eviction
      expect(logger.warn).toHaveBeenCalledOnce();
    });
  });

  describe("requeue", () => {
    it("puts items back at the front with incremented retries", () => {
      const q = new PersistentQueue(10, "key", false, logger);
      q.enqueue(makePayload());
      const [item] = q.dequeue(1);
      q.requeue([item]);

      const [requeued] = q.dequeue(1);
      expect(requeued.retries).toBe(1);
      expect(requeued.lastAttempt).toBeDefined();
    });

    it("trims queue to maxSize after requeue", () => {
      const q = new PersistentQueue(2, "key", false, logger);
      q.enqueue(makePayload());
      q.enqueue(makePayload());
      const items = q.dequeue(2);
      // Now add one more before requeueing
      q.enqueue(makePayload());
      q.requeue(items); // would make 3 items — should trim to 2
      expect(q.size).toBe(2);
    });
  });

  describe("size / isEmpty / peek", () => {
    it("reports correct size", () => {
      const q = new PersistentQueue(10, "key", false, logger);
      expect(q.size).toBe(0);
      q.enqueue(makePayload());
      expect(q.size).toBe(1);
    });

    it("isEmpty is true when empty", () => {
      const q = new PersistentQueue(10, "key", false, logger);
      expect(q.isEmpty).toBe(true);
      q.enqueue(makePayload());
      expect(q.isEmpty).toBe(false);
    });

    it("peek returns a copy without removing items", () => {
      const q = new PersistentQueue(10, "key", false, logger);
      q.enqueue(makePayload());
      const items = q.peek();
      expect(items).toHaveLength(1);
      expect(q.size).toBe(1); // still there
    });
  });

  describe("clear / drain", () => {
    it("clear empties the queue", () => {
      const q = new PersistentQueue(10, "key", false, logger);
      q.enqueue(makePayload());
      q.clear();
      expect(q.isEmpty).toBe(true);
    });

    it("drain returns all items and empties queue", () => {
      const q = new PersistentQueue(10, "key", false, logger);
      q.enqueue(makePayload());
      q.enqueue(makePayload());
      const items = q.drain();
      expect(items).toHaveLength(2);
      expect(q.isEmpty).toBe(true);
    });
  });

  describe("persistence (localStorage)", () => {
    beforeEach(() => {
      const store: Record<string, string> = {};
      vi.stubGlobal("localStorage", {
        getItem: vi.fn((k: string) => store[k] ?? null),
        setItem: vi.fn((k: string, v: string) => { store[k] = v; }),
        removeItem: vi.fn((k: string) => { delete store[k]; }),
        clear: vi.fn(() => { Object.keys(store).forEach(k => delete store[k]); }),
      });
    });

    it("persists items to localStorage on enqueue", () => {
      const q = new PersistentQueue(10, "testKey", true, logger);
      q.enqueue(makePayload());
      expect(localStorage.setItem).toHaveBeenCalled();
    });

    it("restores items from localStorage on construction", () => {
      const items = [
        { id: "1", payload: makePayload(), retries: 0, createdAt: Date.now() },
      ];
      (localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(items));

      const q = new PersistentQueue(10, "testKey", true, logger);
      expect(q.size).toBe(1);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Restored 1 items"));
    });

    it("filters out items older than persistence TTL (2h) on restore", () => {
      const old = Date.now() - 3 * 60 * 60 * 1000;
      const items = [
        { id: "1", payload: makePayload(), retries: 0, createdAt: old },
      ];
      (localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(items));

      const q = new PersistentQueue(10, "testKey", true, logger);
      expect(q.size).toBe(0);
    });

    it("does not crash when localStorage throws", () => {
      (localStorage.setItem as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("QuotaExceeded");
      });
      const q = new PersistentQueue(10, "testKey", true, logger);
      expect(() => q.enqueue(makePayload())).not.toThrow();
    });

    it("does not use localStorage when enablePersistence is false", () => {
      const q = new PersistentQueue(10, "testKey", false, logger);
      q.enqueue(makePayload());
      expect(localStorage.setItem).not.toHaveBeenCalled();
    });
  });
});
