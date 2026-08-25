import { Hono } from "hono";
import type { Stats } from "@cookmate/shared";
import { db } from "../db/index.js";
import { recentLimitEvents } from "../limits/budget.js";
import { severityOf } from "../llm/errors.js";

export const statsRoutes = new Hono();

/**
 * GET /api/stats
 *
 * This endpoint exists to answer one question in a job interview:
 * "how do you know they still use it?"
 *
 * Deliberately unauthenticated and aggregate-only — no craving text, no recipe
 * content, no user identifiers. It's a dashboard you can screen-share.
 */
statsRoutes.get("/", (c) => {
  const one = <T>(sql: string, ...params: unknown[]): T =>
    db.prepare(sql).get(...params) as T;

  const totals = one<{
    total: number;
    users: number;
    cooked: number;
    up: number;
    down: number;
    cost: number | null;
    latency: number | null;
  }>(`
    SELECT
      COUNT(*)                                          AS total,
      COUNT(DISTINCT user_id)                           AS users,
      COALESCE(SUM(cooked = 1), 0)                      AS cooked,
      COALESCE(SUM(rating = 'up'), 0)                   AS up,
      COALESCE(SUM(rating = 'down'), 0)                 AS down,
      -- Spend covers every turn, failures included: a truncated generation is
      -- billed like any other, and the point of this number is the real bill.
      SUM(cost_usd)                                     AS cost,
      -- Latency is deliberately scoped to turns that produced a recipe. Since
      -- failures started recording their timings too, averaging them in would
      -- quietly answer "how long does a call take" instead of "how long does a
      -- recipe take" — and a fast failure would look like an improvement.
      AVG(CASE WHEN recipe_json IS NOT NULL THEN latency_ms END) AS latency
    FROM turns
  `);

  const recent = one<{ d7: number; d30: number; active_days: number }>(`
    SELECT
      COALESCE(SUM(created_at >= datetime('now', '-7 days')), 0)  AS d7,
      COALESCE(SUM(created_at >= datetime('now', '-30 days')), 0) AS d30,
      COUNT(DISTINCT CASE WHEN created_at >= datetime('now', '-30 days')
                          THEN date(created_at) END)              AS active_days
    FROM turns
  `);

  // Pass rate and cache hit rate are computed over completed turns only —
  // counting failures as verification failures would conflate two problems.
  const quality = one<{
    completed: number;
    passed: number;
    cache_hits: number;
    scored: number;
    first_pass: number;
    repaired: number;
  }>(`
    SELECT
      COUNT(*)                                     AS completed,
      COALESCE(SUM(verification_ok = 1), 0)        AS passed,
      COALESCE(SUM(cache_status IN ('HIT','PARTIAL')), 0) AS cache_hits,
      -- Repair rates get their own denominator on purpose. attempts is null
      -- for every turn recorded before the loop existed, and folding those into
      -- the divisor would report a falling repair rate that is really just old
      -- data — the classic way a backfilled column lies.
      COALESCE(SUM(attempts IS NOT NULL), 0)       AS scored,
      COALESCE(SUM(attempts = 1 AND verification_ok = 1), 0) AS first_pass,
      COALESCE(SUM(attempts > 1), 0)               AS repaired
    FROM turns
    WHERE recipe_json IS NOT NULL
  `);

  /**
   * FAILURE RATE, AND THE TAXONOMY UNDERNEATH IT.
   *
   * `failTurn` has written `error_code` since error classification shipped, but
   * nothing ever read it back — so every failure was recorded and none was
   * reported. A number you collect and never surface is indistinguishable from
   * one you never collected, right up until someone asks how reliable the
   * system is.
   *
   * Two numbers, because one of them is a lie on its own. The RATE says whether
   * the system is healthy; the BREAKDOWN says what to fix. An error rate that
   * doubles is alarming until you see it is entirely `aborted` — users pressing
   * Stop more often, which is a UX signal, not an outage.
   */
  const errors = one<{ failed: number }>(
    `SELECT COALESCE(SUM(error_code IS NOT NULL), 0) AS failed FROM turns`,
  );

  const byCode = db
    .prepare(
      `SELECT error_code AS code, COUNT(*) AS count
       FROM turns
       WHERE error_code IS NOT NULL AND created_at >= datetime('now', '-30 days')
       GROUP BY error_code
       ORDER BY count DESC`,
    )
    .all() as Array<{ code: string; count: number }>;

  // Errors are counted in the SAME query as turns, so the two series can never
  // disagree about which weeks exist or how a week boundary is computed. Two
  // queries joined in application code is how a chart ends up plotting a 40%
  // error rate for a week whose denominator came from a different GROUP BY.
  const weekly = db
    .prepare(
      `SELECT strftime('%Y-W%W', created_at)          AS week,
              COUNT(*)                                AS turns,
              COALESCE(SUM(error_code IS NOT NULL), 0) AS errors
       FROM turns
       WHERE created_at >= datetime('now', '-84 days')
       GROUP BY week
       ORDER BY week`,
    )
    .all() as Array<{ week: string; turns: number; errors: number }>;

  const stats: Stats = {
    totalTurns: totals.total,
    turnsLast7Days: recent.d7,
    turnsLast30Days: recent.d30,
    distinctUsers: totals.users,
    activeDaysLast30: recent.active_days,
    cookedCount: totals.cooked,
    thumbsUp: totals.up,
    thumbsDown: totals.down,
    verificationPassRate: quality.completed > 0 ? quality.passed / quality.completed : 0,
    // Denominator is ALL turns, not completed ones — a failure rate computed
    // over successes is always zero.
    errorRate: totals.total > 0 ? errors.failed / totals.total : 0,
    errorsByCode: byCode.map((row) => ({ ...row, severity: severityOf(row.code) })),
    firstPassRate: quality.scored > 0 ? quality.first_pass / quality.scored : 0,
    repairRate: quality.scored > 0 ? quality.repaired / quality.scored : 0,
    avgLatencyMs: Math.round(totals.latency ?? 0),
    totalCostUsd: Number((totals.cost ?? 0).toFixed(4)),
    cacheHitRate: quality.completed > 0 ? quality.cache_hits / quality.completed : 0,
    limitEvents: recentLimitEvents(),
    weekly,
  };

  return c.json(stats);
});
