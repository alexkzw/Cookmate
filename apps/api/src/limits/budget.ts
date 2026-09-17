import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { config } from "../config.js";

/**
 * THE DAILY COST CAP.
 *
 * A rate limit and a cost cap defend different things, and neither substitutes
 * for the other:
 *
 *   requests/minute  bounds BURST.  Says nothing about money, because cost per
 *                    request is not constant — the repair loop roughly doubles
 *                    a turn, and effort moves it again.
 *   dollars/day      bounds SPEND.  Says nothing about burst, because fifty
 *                    simultaneous requests all read the same under-cap total
 *                    before any of them has finished being billed.
 *
 * So this file does two things: it reads what has actually been spent, and it
 * reserves an estimate for calls that are in flight and not yet billed.
 *
 * THE RESERVATION IS THE INTERESTING PART. Cost is only known after the model
 * responds, ~26 seconds later, so a cap that reads only recorded spend is
 * blind for the entire duration of every request it is meant to be governing.
 * Reserving a pessimistic estimate up front closes that window; releasing it
 * the moment the true cost lands keeps the estimate from mattering for long.
 *
 * Reservations are LEASES, not locks. They carry an expiry, so a process that
 * crashes mid-stream cannot permanently consume a user's budget — the worst
 * case is that the budget looks smaller than it is until the lease runs out.
 */

/** Why a request was refused. Stable strings: they are logged and asserted on. */
export type LimitReason =
  | "rate_limit"
  | "concurrency"
  | "user_daily_cap"
  | "global_daily_cap"
  // Not a limit on the CALLER at all — the upstream provider is failing and the
  // circuit breaker is shedding load. It lives in the same enum because it is
  // the same decision ("may this request start now?") reaching the same log,
  // and splitting it would mean /api/stats reported refusals from two places.
  | "provider_down";

db.exec(`
-- Refusals are events worth keeping. A cap that fires constantly is set wrong,
-- and a cap that has never fired is unproven — neither is visible if the only
-- record of a rejection is a 429 that reached one browser and vanished.
CREATE TABLE IF NOT EXISTS limit_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_limit_events_created ON limit_events(created_at DESC);
`);

export function recordLimitEvent(userId: string, reason: LimitReason, detail: string): void {
  db.prepare(`INSERT INTO limit_events (id, user_id, reason, detail) VALUES (?, ?, ?, ?)`).run(
    randomUUID(),
    userId,
    reason,
    detail,
  );
}

export interface LimitEventCount {
  reason: string;
  hits: number;
}

/** Refusals in the last 24h, by reason. Surfaced on /api/stats. */
export function recentLimitEvents(): LimitEventCount[] {
  return db
    .prepare(
      `SELECT reason, COUNT(*) AS hits FROM limit_events
       WHERE created_at >= datetime('now', '-1 day')
       GROUP BY reason ORDER BY hits DESC`,
    )
    .all() as LimitEventCount[];
}

interface Lease {
  userId: string;
  costUsd: number;
  expiresAt: number;
}

const leases = new Map<string, Lease>();

/** Drop leases whose request died without releasing. Called before every read. */
function sweep(now: number): void {
  for (const [id, lease] of leases) if (lease.expiresAt <= now) leases.delete(id);
}

/**
 * Claim an estimated spend for a request about to start.
 *
 * The estimate is deliberately pessimistic. Under-estimating lets concurrent
 * requests slip past the cap; over-estimating only makes a user briefly look
 * closer to their limit than they are, and the lease is released as soon as the
 * real number is known. Wrong in the cheap direction.
 */
export function reserve(
  userId: string,
  now: number = Date.now(),
  /**
   * How many turns' worth of money this request will spend.
   *
   * A meal plan runs one planner call and N generations, so it costs several
   * times a single recipe — and a cap that counted it as one would let a user
   * spend 3-4x their daily limit by asking for plans instead of recipes.
   *
   * ONE LEASE WITH A BIGGER NUMBER, not N leases, and the distinction is
   * load-bearing. `inFlight()` counts leases, and it is the concurrency signal:
   * three leases would make a single meal plan look like three simultaneous
   * requests and trip MAX_CONCURRENT_PER_USER (2) against the user's own plan,
   * before it ever reached the model.
   *
   * That is the split the two mechanisms were always meant to have. A rate
   * limit and a concurrency cap bound ACTIONS — a plan is one action a person
   * took. A cost cap bounds MONEY — a plan is four calls' worth. Counting the
   * same request differently in the two places is correct precisely because the
   * two limits defend different things.
   */
  units: number = 1,
): () => void {
  const id = randomUUID();
  leases.set(id, {
    userId,
    costUsd: config.ESTIMATED_TURN_COST_USD * units,
    // Generously beyond the worst turn observed on the eval suite (46s), so a
    // slow-but-alive request is never charged twice. A meal plan is several
    // turns end to end, so its window scales with the work it represents.
    expiresAt: now + 180_000 * Math.max(1, units),
  });
  let released = false;
  return () => {
    // Idempotent: a `finally` that runs after an error path already released is
    // a normal shape, and a double release must not free someone else's lease.
    if (released) return;
    released = true;
    leases.delete(id);
  };
}

/** Requests currently in flight for one user — also the concurrency signal. */
export function inFlight(userId: string, now: number = Date.now()): number {
  sweep(now);
  let n = 0;
  for (const lease of leases.values()) if (lease.userId === userId) n += 1;
  return n;
}

function reservedUsd(userId: string | null, now: number = Date.now()): number {
  sweep(now);
  let total = 0;
  for (const lease of leases.values()) {
    if (userId === null || lease.userId === userId) total += lease.costUsd;
  }
  return total;
}

/** Recorded spend over a ROLLING 24 hours — see the note in `budgetFor`. */
function spentUsd(userId: string | null): number {
  const row = userId
    ? (db
        .prepare(
          // Failed turns are included on purpose: a refusal or a truncation is
          // billed like any other call, and a cap that ignored them would let a
          // user loop on a failing request for free. Same rule as /api/stats.
          `SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM turns
           WHERE user_id = ? AND created_at >= datetime('now', '-1 day')`,
        )
        .get(userId) as { spent: number })
    : (db
        .prepare(
          `SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM turns
           WHERE created_at >= datetime('now', '-1 day')`,
        )
        .get() as { spent: number });
  return row.spent;
}

export interface BudgetState {
  /** Billed and recorded in the last 24h. */
  spentUsd: number;
  /** Estimated, in flight, not yet billed. */
  reservedUsd: number;
  capUsd: number;
  remainingUsd: number;
  inFlight: number;
}

/**
 * A ROLLING 24-hour window, not a calendar day.
 *
 * A calendar-day cap resets at a known instant, so the cap is trivially
 * doubled by spending it just before midnight and again just after. The rolling
 * window has no boundary to aim at. It costs one `datetime('now', '-1 day')`
 * and buys a limit that means what it says.
 */
export function budgetFor(userId: string, now: number = Date.now()): BudgetState {
  const spent = spentUsd(userId);
  const reserved = reservedUsd(userId, now);
  return {
    spentUsd: spent,
    reservedUsd: reserved,
    capUsd: config.DAILY_COST_CAP_USD,
    remainingUsd: Math.max(0, config.DAILY_COST_CAP_USD - spent - reserved),
    inFlight: inFlight(userId, now),
  };
}

/**
 * The whole-server backstop.
 *
 * A per-user cap does not bound the bill. Signups are open, so total exposure
 * is (users × cap), which is unbounded by construction — the per-user cap is
 * about fairness between users, and this one is about the credit card.
 */
export function globalBudget(now: number = Date.now()): BudgetState {
  const spent = spentUsd(null);
  const reserved = reservedUsd(null, now);
  return {
    spentUsd: spent,
    reservedUsd: reserved,
    capUsd: config.GLOBAL_DAILY_COST_CAP_USD,
    remainingUsd: Math.max(0, config.GLOBAL_DAILY_COST_CAP_USD - spent - reserved),
    inFlight: leases.size,
  };
}

/** Test seam: drop all leases. Never called by the server. */
export function __resetLeases(): void {
  leases.clear();
}
