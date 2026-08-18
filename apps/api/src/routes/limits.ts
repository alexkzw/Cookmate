import { Hono } from "hono";
import { requireAuth } from "../auth.js";
import { limitStatus } from "../limits/middleware.js";

export const limitRoutes = new Hono();

/**
 * GET /api/limits — where the caller stands right now.
 *
 * Authed and per-user, unlike /api/stats: this is one person's budget, so it
 * says what they have spent and what they have left.
 *
 * It exists for two reasons. The UI can warn before a request is refused rather
 * than after, which turns a 429 from a failure into a number someone watched
 * count down. And it makes the limits OBSERVABLE without spending anything —
 * you can watch the counters move under load instead of inferring the policy
 * from which requests happened to fail.
 */
limitRoutes.get("/", requireAuth, (c) => c.json(limitStatus(c.get("user").id)));
