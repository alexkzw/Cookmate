/**
 * A per-key sliding-window rate limiter, in memory.
 *
 * WHY IN MEMORY, AND WHAT THAT COSTS
 * This bounds burst, not spend, and burst is a per-process concern: one Node
 * process can only stream so many responses at once regardless of what any
 * other process thinks. Putting it in SQLite would add a write to the hot path
 * of every request to defend against a failure mode a single-process deployment
 * does not have. The honest limitation is that N processes behind a load
 * balancer each enforce their own window, so the effective limit is N × limit —
 * at which point this moves to Redis and the interface below does not change.
 *
 * Contrast the daily cost cap, which is deliberately NOT in memory: money spent
 * must survive a restart, or a deploy loop becomes a way to reset the budget.
 *
 * The window slides rather than resetting on a fixed boundary. A fixed window
 * lets a caller spend its whole allowance at 11:59:59 and again at 12:00:00,
 * which is twice the intended rate at exactly the moment you least want it.
 */

export interface WindowDecision {
  allowed: boolean;
  /** How many more requests this key may make right now. */
  remaining: number;
  /** Seconds until the oldest hit falls out of the window. 0 when allowed. */
  retryAfterSeconds: number;
}

export class SlidingWindow {
  /** key -> ascending timestamps of hits still inside the window */
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Check and record in one step.
   *
   * Deliberately not a separate `check()` then `record()`. Two calls is a
   * check-then-act race: under concurrency several requests can each observe
   * the same under-limit state before any of them writes. Node's single
   * threaded event loop makes that safe *here*, but an interface that only
   * works because of the runtime is one refactor away from being wrong.
   */
  take(key: string, now: number = Date.now()): WindowDecision {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        remaining: 0,
        // Round up: telling a caller to retry in 0 seconds invites a hot loop.
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, remaining: this.limit - recent.length, retryAfterSeconds: 0 };
  }

  /** Read-only view, for GET /api/limits. Does not consume an allowance. */
  peek(key: string, now: number = Date.now()): WindowDecision {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      };
    }
    return { allowed: true, remaining: this.limit - recent.length, retryAfterSeconds: 0 };
  }

  /**
   * Drop keys with no hits left in the window.
   *
   * Without this the map grows once per distinct user forever, which is a slow
   * leak rather than a fast one — the kind that survives every test and shows up
   * as a memory graph climbing over a fortnight.
   */
  sweep(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => t > cutoff);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }

  /** Number of tracked keys. Exposed for tests and for a memory sanity check. */
  get size(): number {
    return this.hits.size;
  }
}
