/**
 * Central per-connector token-bucket rate limiter.
 *
 * Free API tiers are the binding constraint, so the engine queues (delays)
 * requests rather than failing them. This same component is the monetization
 * lever later: higher plans get bigger buckets / more concurrency.
 */

import type { RateLimitSpec } from "./types.ts";

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = now;
  }
  /** ms to wait until a token is available (0 if one is ready now). */
  private refill(now: number) {
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }
  take(now: number): number {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  /** Injectable clock keeps the limiter testable without real time. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  private bucketFor(key: string, spec: RateLimitSpec): TokenBucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(spec.requests, spec.requests / spec.intervalMs, this.now());
      this.buckets.set(key, b);
    }
    return b;
  }

  /** Block until the connector's bucket grants a token. */
  async acquire(connectorId: string, spec: RateLimitSpec | undefined): Promise<void> {
    if (!spec) return;
    const bucket = this.bucketFor(connectorId, spec);
    // Loop because concurrent callers may race for the same freed token.
    for (;;) {
      const wait = bucket.take(this.now());
      if (wait === 0) return;
      await sleep(wait);
    }
  }
}
