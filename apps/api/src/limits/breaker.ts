import type { ErrorInfo } from "../llm/errors.js";

/**
 * A CIRCUIT BREAKER over the model provider.
 *
 * WHY THIS EXISTS, IN NUMBERS FROM THIS REPO
 * `llm/client.ts` sets `timeout: 120_000` and `maxRetries: 2`, and the SDK
 * retries timeouts — so a single request against a dead provider occupies a
 * socket for up to 120s x 3 = SIX MINUTES before it fails. Three things break
 * during that window, and none of them is the failure itself:
 *
 *   1. It holds a concurrency slot. `MAX_CONCURRENT_PER_USER` then refuses the
 *      user's next request for six minutes on the strength of a request that
 *      was never going to succeed.
 *   2. The budget lease expires underneath it. Leases live 180s (`budget.ts`),
 *      so a six-minute request stops being reserved while it is still running —
 *      the exact hole the reservation exists to close, reopened by latency.
 *   3. Every caller pays the full six minutes to learn what the first caller
 *      already knew.
 *
 * A breaker converts a slow failure into a fast one. That is the whole value:
 * it does not make anything succeed, it stops a known-failing call from
 * consuming the resources that healthy calls need.
 *
 * WHAT TRIPS IT, AND WHAT DELIBERATELY DOES NOT
 * Only PROVIDER-FAULT codes count. A refusal, a bad request or a schema
 * mismatch says something about our prompt, our request shape or this specific
 * input — none of them is evidence that the next caller's request will fail, so
 * letting them open the circuit would take the whole app down over one
 * malformed input. This distinction is the entire design; see `TRIPPING`.
 *
 * GLOBAL, NOT PER-USER. The provider is shared infrastructure. Keying this by
 * user would make each user independently rediscover the outage, which is
 * precisely the cost the breaker exists to avoid paying twice.
 *
 * IN MEMORY, like the rate window and for the same reason: this is a statement
 * about what *this process* is currently observing, and a process that just
 * booted has genuinely observed nothing. Persisting it would mean a fresh
 * deploy inherits a stale opinion about a provider it has not yet called.
 */

/**
 * Failures that are evidence about the PROVIDER rather than about one request.
 *
 * Read this list as the answer to "would the next caller also fail?" — that is
 * the only question a breaker is entitled to act on.
 */
const TRIPPING = new Set(["provider_error", "overloaded", "timeout", "connection_error"]);

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerConfig {
  /** Consecutive tripping failures before the circuit opens. */
  threshold: number;
  /** How long to stay open before allowing a single probe, in ms. */
  cooldownMs: number;
  /**
   * How long a half-open probe may stay unreported before another is allowed.
   *
   * A PROBE IS A LEASE, NOT A LOCK — the same rule as the budget reservations
   * in `budget.ts`, and for the same reason. `decide()` hands out the probe
   * slot before the call is made, but the call may never happen: a later gate
   * can still refuse the request, or the process can die holding it. Without an
   * expiry, one lost probe wedges the breaker half-open forever and the app
   * never recovers from an outage that ended. Anything you claim before doing
   * the work has to be able to expire.
   */
  probeTimeoutMs: number;
}

const DEFAULTS: BreakerConfig = {
  // Three, not one: providers return the occasional 500 under normal operation,
  // and a breaker that opens on a single blip is an outage generator rather
  // than an outage detector.
  threshold: 3,
  // 30s. Long enough that a probe is not just the same failure again; short
  // enough that a resolved incident does not keep the app down for minutes
  // after the provider has recovered.
  cooldownMs: 30_000,
  // A probe that has not reported back in 60s is itself evidence of an
  // unhealthy provider, so letting a second one through costs one request and
  // buys a guarantee that the breaker cannot get stuck.
  probeTimeoutMs: 60_000,
};

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  /** When the in-flight half-open probe was handed out. Null when none is. */
  private probingSince: number | null = null;

  constructor(private readonly cfg: BreakerConfig = DEFAULTS) {}

  state(now: number = Date.now()): BreakerState {
    if (this.openedAt === null) return "closed";
    return now - this.openedAt >= this.cfg.cooldownMs ? "half_open" : "open";
  }

  /**
   * May a request proceed?
   *
   * In `half_open` this returns true for exactly ONE caller and false for the
   * rest, so recovery is tested with a single request rather than by releasing
   * the full backlog at a provider that may still be down — the stampede that
   * turns a recovering incident back into an outage.
   */
  allow(now: number = Date.now()): boolean {
    const state = this.state(now);
    if (state === "closed") return true;
    if (state === "open") return false;

    const probeIsLive =
      this.probingSince !== null && now - this.probingSince < this.cfg.probeTimeoutMs;
    if (probeIsLive) return false;

    this.probingSince = now;
    return true;
  }

  /** Seconds until the next probe is allowed. 0 when a call may proceed now. */
  retryAfterSeconds(now: number = Date.now()): number {
    if (this.openedAt === null) return 0;
    const remaining = this.cfg.cooldownMs - (now - this.openedAt);
    return remaining <= 0 ? 1 : Math.ceil(remaining / 1000);
  }

  /**
   * A call completed without a provider fault.
   *
   * Any success closes the circuit outright rather than decrementing a counter.
   * A provider is either serving traffic or it is not; "mostly recovered" is
   * not a state worth modelling, and a half-closed breaker would keep refusing
   * requests the provider is now demonstrably able to serve.
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probingSince = null;
  }

  /**
   * A call failed. Only provider faults move the breaker; everything else is
   * recorded as a success from the circuit's point of view, because the
   * provider answered — it just answered with something we didn't want.
   */
  recordFailure(error: Pick<ErrorInfo, "code">, now: number = Date.now()): void {
    if (!TRIPPING.has(error.code)) {
      this.recordSuccess();
      return;
    }

    this.probingSince = null;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.cfg.threshold) {
      // Re-stamp on every failure at or past the threshold, so a probe that
      // fails restarts the full cooldown instead of immediately half-opening
      // again and hammering a provider that is still down.
      this.openedAt = now;
    }
  }

  /** For tests and for GET /api/stats. Never used to make a decision. */
  snapshot(now: number = Date.now()) {
    return {
      state: this.state(now),
      consecutiveFailures: this.consecutiveFailures,
      retryAfterSeconds: this.retryAfterSeconds(now),
    };
  }

  /** Test seam. Never called in production code. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probingSince = null;
  }
}

/**
 * The process-wide breaker for the Anthropic API.
 *
 * One instance, exported directly, because there is exactly one upstream. If a
 * second provider is ever added this becomes a map keyed by provider — and the
 * call sites do not change, which is the point of keeping `allow()` and
 * `recordFailure()` as the entire interface.
 */
export const providerBreaker = new CircuitBreaker();
