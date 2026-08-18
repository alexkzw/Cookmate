import type { Context, Next } from "hono";
import { config } from "../config.js";
import { SlidingWindow } from "./window.js";
import {
  budgetFor,
  globalBudget,
  inFlight,
  recordLimitEvent,
  reserve,
  type LimitReason,
} from "./budget.js";

/**
 * Admission control for the expensive endpoint.
 *
 * Runs AFTER `requireAuth`, necessarily — every limit here is per-user, and
 * there is no user to key on until the token is verified. It runs BEFORE any
 * model call, which is the entire point: a refusal that happens after the
 * money is spent is a log line, not a limit.
 *
 * CHECKS ARE ORDERED CHEAPEST FIRST. Concurrency and rate are map lookups;
 * the cost caps are SQL. A request the in-memory counters already refused
 * should never reach the database — under exactly the burst this exists to
 * survive, that ordering is the difference between shedding load and adding to
 * it.
 */

const perMinute = new SlidingWindow(config.RATE_LIMIT_PER_MINUTE, 60_000);

// Bounded work, once a minute, so the key map cannot grow without limit.
// `unref` so this timer never holds the process open.
setInterval(() => perMinute.sweep(), 60_000).unref();

declare module "hono" {
  interface ContextVariableMap {
    /** Release the budget lease. The route MUST call this in a `finally`. */
    releaseBudget: () => void;
  }
}

interface Refusal {
  reason: LimitReason;
  message: string;
  detail: string;
  retryAfterSeconds: number;
}

/** Pure decision, so the policy is testable without a server or a request. */
export function decide(userId: string, now: number = Date.now()): Refusal | null {
  const concurrent = inFlight(userId, now);
  if (concurrent >= config.MAX_CONCURRENT_PER_USER) {
    return {
      reason: "concurrency",
      message: `You already have ${concurrent} recipe${concurrent === 1 ? "" : "s"} generating. Wait for one to finish.`,
      detail: `${concurrent} in flight, max ${config.MAX_CONCURRENT_PER_USER}`,
      // A turn takes ~26s; one should free up well inside 30.
      retryAfterSeconds: 30,
    };
  }

  const window = perMinute.take(userId, now);
  if (!window.allowed) {
    return {
      reason: "rate_limit",
      message: "You're generating recipes faster than we can cook them. Try again shortly.",
      detail: `> ${config.RATE_LIMIT_PER_MINUTE}/min`,
      retryAfterSeconds: window.retryAfterSeconds,
    };
  }

  const user = budgetFor(userId, now);
  if (user.remainingUsd <= 0) {
    return {
      reason: "user_daily_cap",
      message: "You've hit today's generation limit. It resets over the next 24 hours.",
      detail: `$${user.spentUsd.toFixed(4)} spent + $${user.reservedUsd.toFixed(4)} reserved >= $${user.capUsd.toFixed(2)}`,
      retryAfterSeconds: 3600,
    };
  }

  const global = globalBudget(now);
  if (global.remainingUsd <= 0) {
    return {
      reason: "global_daily_cap",
      message: "Cookmate has hit its daily budget. Please try again tomorrow.",
      detail: `$${global.spentUsd.toFixed(4)} spent + $${global.reservedUsd.toFixed(4)} reserved >= $${global.capUsd.toFixed(2)}`,
      retryAfterSeconds: 3600,
    };
  }

  return null;
}

export async function enforceLimits(c: Context, next: Next): Promise<Response | void> {
  const user = c.get("user");
  const refusal = decide(user.id);

  if (refusal) {
    recordLimitEvent(user.id, refusal.reason, refusal.detail);
    console.warn(`[limits] refused ${user.id}: ${refusal.reason} (${refusal.detail})`);
    c.header("Retry-After", String(refusal.retryAfterSeconds));
    return c.json({ error: refusal.message, code: refusal.reason }, 429);
  }

  // Claim the estimated spend before the model is called. Released by the route
  // once the true cost is known; expires on its own if the process dies first.
  const release = reserve(user.id);
  c.set("releaseBudget", release);

  try {
    await next();
  } catch (err) {
    // `next()` throwing means the route never got far enough to own the lease.
    release();
    throw err;
  }
}

/** Read-only view of the caller's current standing. */
export function limitStatus(userId: string, now: number = Date.now()) {
  const user = budgetFor(userId, now);
  const global = globalBudget(now);
  const window = perMinute.peek(userId, now);
  return {
    spentUsd: Number(user.spentUsd.toFixed(4)),
    reservedUsd: Number(user.reservedUsd.toFixed(4)),
    capUsd: user.capUsd,
    remainingUsd: Number(user.remainingUsd.toFixed(4)),
    inFlight: user.inFlight,
    maxConcurrent: config.MAX_CONCURRENT_PER_USER,
    requestsRemainingThisMinute: window.remaining,
    requestsPerMinute: config.RATE_LIMIT_PER_MINUTE,
    globalSpentUsd: Number(global.spentUsd.toFixed(4)),
    globalCapUsd: global.capUsd,
  };
}
