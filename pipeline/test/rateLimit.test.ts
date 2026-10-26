import { describe, expect, it } from "vitest";
import { FailureThrottle, RateLimiter } from "../src/rateLimit.js";

function clockAt(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("RateLimiter", () => {
  it("allows a burst, refuses past it, and refills over time", () => {
    const clock = clockAt();
    const limiter = new RateLimiter(3, 1, clock);

    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);

    clock.advance(1000);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("keeps one bucket per key", () => {
    const clock = clockAt();
    const limiter = new RateLimiter(1, 0, clock);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
  });
});

describe("FailureThrottle", () => {
  it("blocks after the limit and reports how long to wait", () => {
    const clock = clockAt();
    const throttle = new FailureThrottle(3, 60_000, 30_000, clock);

    expect(throttle.retryAfter("ip")).toBeNull();
    throttle.fail("ip");
    throttle.fail("ip");
    expect(throttle.retryAfter("ip")).toBeNull();
    throttle.fail("ip");
    expect(throttle.retryAfter("ip")).toBe(30);
  });

  it("forgets a key after a correct password", () => {
    const clock = clockAt();
    const throttle = new FailureThrottle(2, 60_000, 30_000, clock);
    throttle.fail("ip");
    throttle.fail("ip");
    expect(throttle.retryAfter("ip")).toBe(30);
    throttle.succeed("ip");
    expect(throttle.retryAfter("ip")).toBeNull();
  });

  it("lets the key try again once the block expires", () => {
    const clock = clockAt();
    const throttle = new FailureThrottle(1, 60_000, 10_000, clock);
    throttle.fail("ip");
    expect(throttle.retryAfter("ip")).toBe(10);
    clock.advance(10_000);
    expect(throttle.retryAfter("ip")).toBeNull();
  });
});
