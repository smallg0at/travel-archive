/**
 * Cheap, in-memory limits for the two places where an unauthenticated caller
 * can cost something: guessing the archive password, and making the server
 * fetch thumbnails from OneDrive.
 *
 * Deliberately not a general middleware. There is no user store and no proxy
 * in front of this server, so the only identity available is the socket
 * address — which is enough for a home network and honest about its limits:
 * everyone behind one NAT or on one phone shares a bucket, and a restart
 * forgets everything. Both are acceptable for the failure being prevented
 * (a script trying thousands of passwords, or one client pulling the whole
 * library through Graph), and neither is a substitute for TLS.
 */

export interface Clock {
  now(): number;
}

const realClock: Clock = { now: () => Date.now() };

/** A token bucket per key: `capacity` burst, then `refillPerSecond` sustained. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: Clock = realClock,
  ) {}

  take(key: string): boolean {
    const now = this.clock.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    const tokens = Math.min(
      this.capacity,
      bucket.tokens + ((now - bucket.at) / 1000) * this.refillPerSecond,
    );
    const allowed = tokens >= 1;
    this.buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, at: now });
    this.prune(now);
    return allowed;
  }

  /** Forget idle keys so a long-lived server does not grow an entry per address. */
  private prune(now: number): void {
    if (this.buckets.size < 1024) return;
    const idle = (this.capacity / this.refillPerSecond) * 1000 * 2;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > idle) this.buckets.delete(key);
    }
  }
}

/**
 * Blocks a key after `limit` failures until `blockMs` after the last one.
 *
 * Counts *consecutive* failures: a correct password clears the record, so a
 * family member who mistypes once is not locked out for the evening.
 */
export class FailureThrottle {
  private readonly failures = new Map<string, { count: number; at: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly blockMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  /** Seconds to wait, or null when the key may try now. */
  retryAfter(key: string): number | null {
    const record = this.failures.get(key);
    if (!record) return null;
    const now = this.clock.now();
    if (now - record.at > this.windowMs + this.blockMs) {
      this.failures.delete(key);
      return null;
    }
    if (record.count < this.limit) return null;
    const remaining = this.blockMs - (now - record.at);
    return remaining > 0 ? Math.ceil(remaining / 1000) : null;
  }

  fail(key: string): void {
    const now = this.clock.now();
    const record = this.failures.get(key);
    const count = record && now - record.at <= this.windowMs ? record.count + 1 : 1;
    this.failures.set(key, { count, at: now });
    this.prune(now);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }

  private prune(now: number): void {
    if (this.failures.size < 1024) return;
    for (const [key, record] of this.failures) {
      if (now - record.at > this.windowMs + this.blockMs) this.failures.delete(key);
    }
  }
}
