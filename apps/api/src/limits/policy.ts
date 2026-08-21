import { config } from "../config.js";
import { SlidingWindow } from "./window.js";
import { budgetFor, globalBudget, inFlight, type LimitReason } from "./budget.js";

/**
 * THE ADMISSION POLICY — deliberately transport-agnostic.
 *
 * This file knows nothing about HTTP. It doesn't import Hono, it doesn't touch
 * a request or a response, and it never sends anything: it answers one
 * question, "may this user start an expensive call right now", and returns a
 * value.
 *
 * That separation stopped being theoretical the moment the MCP server existed.
 * An MCP tool call arrives over stdio with no Hono context to run middleware
 * against — so if the limits had been written *inside* `enforceLimits`, adding
 * a second entry point would have quietly created an unmetered one, where an
 * agent could call `suggest_recipe` in a loop with no rate limit and no cost
 * cap. Because the policy is a pure function, both callers share it.
 *
 * The general rule: keep the decision separate from the delivery. Middleware is
 * a delivery mechanism, and delivery mechanisms multiply.
 */

const perMinute = new SlidingWindow(config.RATE_LIMIT_PER_MINUTE, 60_000);

// Bounded work, once a minute, so the key map cannot grow without limit.
// `unref` so this timer never holds the process open.
setInterval(() => perMinute.sweep(), 60_000).unref();

export interface Refusal {
  reason: LimitReason;
  message: string;
  detail: string;
  retryAfterSeconds: number;
}

/**
 * May this user start an expensive call?
 *
 * Checks are ordered cheapest first: concurrency and rate are map lookups, the
 * cost caps are SQL. A request the in-memory counters already refused should
 * never reach the database — under exactly the burst this exists to survive,
 * that ordering is the difference between shedding load and adding to it.
 */
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
