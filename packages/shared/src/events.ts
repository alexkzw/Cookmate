import { z } from "zod";
import { RecipeSchema } from "./recipe.js";
import { VerificationSchema } from "./constraints.js";

/**
 * The SSE wire protocol between the API and the browser.
 *
 * Recipe generation is two-phase and the UI is honest about it:
 *   1. `delta` events stream the model's tokens so the card fills in live.
 *   2. `recipe` lands the parsed, schema-valid object.
 *   3. `verification` lands *after*, once we've deterministically checked the
 *      recipe against the request. The badge resolves from "checking" to
 *      pass/fail at that moment.
 *
 * Discriminated union on `type` so the client's switch is exhaustive.
 */

export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), turnId: z.string() }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("recipe"), recipe: RecipeSchema }),
  /**
   * The first attempt failed verification and we're asking the model to fix it.
   * Sent because the browser has already watched a recipe stream in — a silent
   * second attempt would read as a stall, and hiding the retry would misrepresent
   * what the system actually did.
   */
  z.object({ type: z.literal("repairing"), issues: z.array(z.string()) }),
  /**
   * The model returned something that wasn't a Recipe at all — unparseable or
   * empty — and we are sampling again. Distinct from `repairing`, which means
   * we got a valid Recipe that broke a rule. The client must CLEAR its delta
   * buffer on this event: the tokens it has been scraping a preview from belong
   * to a generation that is being thrown away.
   */
  z.object({ type: z.literal("retrying"), reason: z.string() }),
  z.object({ type: z.literal("verification"), verification: VerificationSchema }),
  z.object({
    type: z.literal("done"),
    turnId: z.string(),
    usage: z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadTokens: z.number(),
      cacheWriteTokens: z.number(),
      costUsd: z.number(),
      cacheStatus: z.enum(["HIT", "MISS", "PARTIAL", "NONE"]),
      model: z.string(),
      latencyMs: z.number(),
    }),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    code: z.string(),
    /**
     * The turn this failure was recorded against.
     *
     * Sent so the user has something to quote. "It didn't work" is
     * unactionable; "turn 9f3c… failed" is one indexed lookup away from the
     * error code, the scrubbed provider message, the request id, the rendered
     * prompt and the exact cost. A support path that starts with a reference
     * number is the difference between a report we can act on and one we can't.
     */
    turnId: z.string(),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

/** POST /api/feedback */
export const FeedbackSchema = z
  .object({
    turnId: z.string(),
    /** The two signals that matter: did they like it, did they actually cook it. */
    rating: z.enum(["up", "down"]).nullable(),
    cooked: z.boolean().nullable(),
    note: z.string().max(1000).nullable(),
  })
  .strict();
export type Feedback = z.infer<typeof FeedbackSchema>;

/** GET /api/stats — the "how do I know they still use it" endpoint. */
export const StatsSchema = z
  .object({
    totalTurns: z.number(),
    turnsLast7Days: z.number(),
    turnsLast30Days: z.number(),
    distinctUsers: z.number(),
    activeDaysLast30: z.number(),
    cookedCount: z.number(),
    thumbsUp: z.number(),
    thumbsDown: z.number(),
    verificationPassRate: z.number(),
    /**
     * Share of ALL turns that ended in an error. The headline reliability
     * number, and the one this endpoint had no answer for: `failTurn` has
     * always written `error_code`, but nothing ever read it back, so failures
     * were recorded and never reported.
     */
    errorRate: z.number(),
    /**
     * Failures in the last 30 days by code, with the severity that decides
     * whether anyone should care. Severity is derived at read time, not stored —
     * it is today's policy about what to investigate, not a record of the past.
     */
    errorsByCode: z.array(
      z.object({
        code: z.string(),
        severity: z.enum(["info", "warning", "critical"]),
        count: z.number(),
      }),
    ),
    /**
     * Passed WITHOUT needing a repair. The honest quality number: once the
     * repair loop is on, `verificationPassRate` is close to 1 by construction,
     * because a failing recipe gets a second chance before anyone sees it.
     */
    firstPassRate: z.number(),
    /** Share of turns that needed a second attempt — the loop's real workload. */
    repairRate: z.number(),
    avgLatencyMs: z.number(),
    totalCostUsd: z.number(),
    cacheHitRate: z.number(),
    /**
     * Requests refused by admission control in the last 24h, by reason.
     * A cap that fires constantly is set wrong; a cap that has never fired is
     * unproven. Neither is visible if a 429 only ever reaches one browser.
     */
    limitEvents: z.array(z.object({ reason: z.string(), hits: z.number() })),
    /**
     * Turns and errors per week, together.
     *
     * Together deliberately: an error COUNT rising because traffic rose is not
     * a regression, and the two series side by side are what make a rate
     * readable. A single incident and a systematic regression look identical in
     * a total; they look nothing alike in a weekly rate.
     */
    weekly: z.array(
      z.object({ week: z.string(), turns: z.number(), errors: z.number() }),
    ),
  })
  .strict();
export type Stats = z.infer<typeof StatsSchema>;
