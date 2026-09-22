import { describe, expect, it } from "vitest";

import { LoginAttemptLimiter } from "../../src/web/login-throttle.js";

describe("login attempt limiter", () => {
  it("blocks an account key after the configured failure window threshold", () => {
    let now = 1_000;
    const limiter = new LoginAttemptLimiter({
      maxFailures: 2,
      windowMs: 10_000,
      now: () => now,
    });

    expect(limiter.check("User@Example.Test")).toEqual({ allowed: true });
    limiter.recordFailure("user@example.test");
    limiter.recordFailure(" USER@example.test ");
    expect(limiter.check("user@example.test")).toEqual({
      allowed: false,
      retryAfterSeconds: 10,
    });

    now += 10_001;
    expect(limiter.check("user@example.test")).toEqual({ allowed: true });
  });

  it("does not block another account and clears failures after success", () => {
    const limiter = new LoginAttemptLimiter({ maxFailures: 1, windowMs: 60_000 });

    limiter.recordFailure("first@example.test");
    expect(limiter.check("first@example.test").allowed).toBe(false);
    expect(limiter.check("second@example.test")).toEqual({ allowed: true });

    limiter.clear("first@example.test");
    expect(limiter.check("first@example.test")).toEqual({ allowed: true });
  });

  it("bounds tracked subjects under password-spraying input", () => {
    const limiter = new LoginAttemptLimiter({
      maxFailures: 1,
      windowMs: 60_000,
      maxTrackedSubjects: 2,
    });

    limiter.recordFailure("one@example.test");
    limiter.recordFailure("two@example.test");
    limiter.recordFailure("three@example.test");

    expect(limiter.trackedSubjectCount()).toBe(2);
    expect(limiter.check("one@example.test")).toEqual({ allowed: true });
    expect(limiter.check("three@example.test").allowed).toBe(false);
  });
});
