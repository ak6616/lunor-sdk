import { describe, it, expect } from "vitest";
import { Sanitizer } from "../src/utils/sanitizer";

describe("Sanitizer", () => {
  const sanitizer = new Sanitizer();

  it("redacts default sensitive fields", () => {
    const result = sanitizer.sanitize({
      username: "john",
      password: "secret123",
      token: "abc-xyz",
      email: "john@test.com",
    });

    expect(result).toEqual({
      username: "john",
      password: "[REDACTED]",
      token: "[REDACTED]",
      email: "john@test.com",
    });
  });

  it("handles nested objects", () => {
    const result = sanitizer.sanitize({
      user: {
        name: "John",
        credentials: {
          password: "secret",
          apiKey: "key-123",
        },
      },
    });

    expect(result).toEqual({
      user: {
        name: "John",
        credentials: {
          password: "[REDACTED]",
          apiKey: "[REDACTED]",
        },
      },
    });
  });

  it("handles arrays", () => {
    const result = sanitizer.sanitize([
      { name: "John", password: "secret" },
      { name: "Jane", password: "hidden" },
    ]);

    expect(result).toEqual([
      { name: "John", password: "[REDACTED]" },
      { name: "Jane", password: "[REDACTED]" },
    ]);
  });

  it("handles null and undefined", () => {
    expect(sanitizer.sanitize(null)).toBeNull();
    expect(sanitizer.sanitize(undefined)).toBeUndefined();
  });

  it("prevents infinite recursion", () => {
    // 10+ levels deep
    let deep: Record<string, unknown> = { password: "secret" };
    for (let i = 0; i < 15; i++) {
      deep = { nested: deep };
    }

    // Should not throw
    const result = sanitizer.sanitize(deep);
    expect(result).toBeTruthy();
  });

  it("supports custom sensitive fields", () => {
    const custom = new Sanitizer(["mySecret", "internalCode"]);

    const result = custom.sanitize({
      name: "visible",
      mySecret: "hidden",
      internalCode: "also-hidden",
      password: "default-hidden",
    });

    expect(result).toEqual({
      name: "visible",
      mySecret: "[REDACTED]",
      internalCode: "[REDACTED]",
      password: "[REDACTED]",
    });
  });
});
