import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "../retry";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result when the function succeeds on the first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelay: 100,
      maxDelay: 1000,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and returns on eventual success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("success");

    const promise = withRetry(fn, {
      maxRetries: 3,
      baseDelay: 10,
      maxDelay: 100,
    });

    // Advance timers to let sleep() calls resolve
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error when all retries are exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    const promise = withRetry(fn, {
      maxRetries: 2,
      baseDelay: 10,
      maxDelay: 100,
    });

    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const caught = promise.catch((e: Error) => e);
    await vi.runAllTimersAsync();

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("always fails");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("calls onRetry callback with attempt number and error", async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("err"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, {
      maxRetries: 3,
      baseDelay: 10,
      maxDelay: 100,
      onRetry,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it("wraps non-Error throws into an Error", async () => {
    const fn = vi.fn().mockRejectedValue("string error");

    const promise = withRetry(fn, {
      maxRetries: 0,
      baseDelay: 10,
      maxDelay: 100,
    });

    const caught = promise.catch((e: Error) => e);
    await vi.runAllTimersAsync();

    const err = await caught;
    expect((err as Error).message).toContain("string error");
  });

  it("does not call onRetry after the last attempt", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    const promise = withRetry(fn, {
      maxRetries: 2,
      baseDelay: 10,
      maxDelay: 100,
      onRetry,
    });

    const caught = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await caught;

    // onRetry is called for attempts 0 and 1 (not after the final failure)
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("maxRetries: 0 means only one attempt and no retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    const promise = withRetry(fn, {
      maxRetries: 0,
      baseDelay: 10,
      maxDelay: 100,
    });

    const caught = promise.catch((e: Error) => e);
    await vi.runAllTimersAsync();

    const err = await caught;
    expect((err as Error).message).toBe("fail");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
