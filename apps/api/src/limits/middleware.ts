import type { Context, Next } from "hono";
import { recordLimitEvent, reserve } from "./budget.js";
import { decide } from "./policy.js";

/**
 * The Hono adapter for the admission policy.
 *
 * All this does is translate: call `decide()`, and turn a `Refusal` into a 429.
 * The policy itself lives in `policy.ts` and is shared with the MCP server,
 * which has no HTTP context to run middleware against.
 *
 * Runs AFTER `requireAuth`, necessarily — every limit is per-user, and there is
 * no user to key on until the token is verified. It runs BEFORE any model call,
 * which is the entire point: a refusal that happens after the money is spent is
 * a log line, not a limit.
 */

declare module "hono" {
  interface ContextVariableMap {
    /** Release the budget lease. The route MUST call this in a `finally`. */
    releaseBudget: () => void;
  }
}

/**
 * Build the middleware for a route that spends `units` turns' worth of money.
 *
 * A single recipe is one unit. A three-day meal plan is four — one planner call
 * and three generations — and reserving one for it would let a user spend most
 * of a day's budget past a cap that believed it had stopped them.
 *
 * ONLY THE MONEY SCALES. The rate limit and the concurrency cap still see one
 * request, because a plan IS one request: one thing the person asked for, one
 * connection held open, one slot. Burst and spend are different quantities and
 * this is the case that makes the difference concrete rather than theoretical.
 */
export function enforceLimitsFor(units: number) {
  return async function limits(c: Context, next: Next): Promise<Response | void> {
    const user = c.get("user");
    const refusal = decide(user.id);

    if (refusal) {
      recordLimitEvent(user.id, refusal.reason, refusal.detail);
      console.warn(`[limits] refused ${user.id}: ${refusal.reason} (${refusal.detail})`);
      c.header("Retry-After", String(refusal.retryAfterSeconds));
      // 429 for "you asked for too much", 503 for "we are broken". The client
      // shows a different message for each, and a retrying caller must be able
      // to tell "back off" from "not your fault".
      return c.json({ error: refusal.message, code: refusal.reason }, refusal.status ?? 429);
    }

    // Claim the estimated spend before the model is called. Released by the route
    // once the true cost is known; expires on its own if the process dies first.
    const release = reserve(user.id, Date.now(), units);
    c.set("releaseBudget", release);

    try {
      await next();
    } catch (err) {
      // `next()` throwing means the route never got far enough to own the lease.
      release();
      throw err;
    }
  };
}

/** The single-recipe case. */
export const enforceLimits = enforceLimitsFor(1);
