import { Hono } from "hono";
import type { Stats } from "@cookable/shared";
import { db } from "../db/index.js";

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
      SUM(cost_usd)                                     AS cost,
      AVG(latency_ms)                                   AS latency
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
  const quality = one<{ completed: number; passed: number; cache_hits: number }>(`
    SELECT
      COUNT(*)                                     AS completed,
      COALESCE(SUM(verification_ok = 1), 0)        AS passed,
      COALESCE(SUM(cache_status IN ('HIT','PARTIAL')), 0) AS cache_hits
    FROM turns
    WHERE recipe_json IS NOT NULL
  `);

  const weekly = db
    .prepare(
      `SELECT strftime('%Y-W%W', created_at) AS week, COUNT(*) AS turns
       FROM turns
       WHERE created_at >= datetime('now', '-84 days')
       GROUP BY week
       ORDER BY week`,
    )
    .all() as Array<{ week: string; turns: number }>;

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
    avgLatencyMs: Math.round(totals.latency ?? 0),
    totalCostUsd: Number((totals.cost ?? 0).toFixed(4)),
    cacheHitRate: quality.completed > 0 ? quality.cache_hits / quality.completed : 0,
    weekly,
  };

  return c.json(stats);
});
