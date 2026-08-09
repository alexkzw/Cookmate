import { Hono } from "hono";
import { FeedbackSchema } from "@cookmate/shared";
import { requireAuth } from "../auth.js";
import { recordFeedback } from "../telemetry/turns.js";

export const feedbackRoutes = new Hono();

/**
 * POST /api/feedback
 *
 * Two signals, and the second one is the valuable one:
 *   rating  — did they like the look of it (cheap, noisy)
 *   cooked  — did they actually make it (rare, and the only real outcome)
 *
 * Thumbs-down rows are the weekly review queue: they're where the prompt
 * changes come from.
 */
feedbackRoutes.post("/", requireAuth, async (c) => {
  const user = c.get("user");
  const parsed = FeedbackSchema.partial({ rating: true, cooked: true, note: true }).safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const { turnId, ...patch } = parsed.data;
  if (!turnId) return c.json({ error: "turnId is required" }, 400);

  const ok = recordFeedback(turnId, user.id, patch);
  if (!ok) return c.json({ error: "Turn not found" }, 404);
  return c.json({ ok: true });
});
