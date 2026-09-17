import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { MealPlanRequestSchema, type PlanEvent } from "@cookmate/shared";
import { requireAuth } from "../auth.js";
import { enforceLimitsFor } from "../limits/middleware.js";
import { getPantry, getPreferences } from "../db/index.js";
import { RecipeGenerationError } from "../llm/generate.js";
import { classifyError, severityOf } from "../llm/errors.js";
import { providerBreaker } from "../limits/breaker.js";
import { beginWork } from "../lifecycle.js";
import { openTurn, completeTurn, failTurn } from "../telemetry/turns.js";
import { generateMealPlan } from "../llm/planned.js";
import { config } from "../config.js";

export const planRoutes = new Hono();

/**
 * POST /api/plan/stream — a multi-day meal plan over Server-Sent Events.
 *
 * WHY THIS STREAMS, AND WHAT IT BUYS.
 *
 * A three-day plan is one planner call plus three generations: roughly 5s +
 * 3 x 26s, so about 80 seconds end to end. Delivered as a single JSON response
 * that is 80 seconds of spinner, which is long enough that a real user assumes
 * the app is broken and reloads — turning a slow success into a failure plus a
 * duplicate bill.
 *
 * Streaming does not make it faster. It makes the WAIT LEGIBLE, and it front-
 * loads the parts that are ready:
 *
 *   ~0s   plan_start        the request was accepted
 *   ~5s   plan              the verified allocation — the user can already see
 *                           which dinners they are getting and what goes in each
 *   ~31s  meal_recipe (1)   the first cookable recipe, at the same moment a
 *                           single-recipe request would have delivered one
 *   ~57s  meal_recipe (2)
 *   ~83s  meal_recipe (3)
 *
 * The interesting one is `plan` at ~5s. The allocation is the answer to the
 * question the user actually asked — "can I eat for three days from this?" —
 * and it arrives in a twentieth of the total time, because the design put the
 * cheap decision before the expensive writing. A batch response would have
 * withheld it until everything else was finished.
 */
/**
 * What a plan reserves against the daily cost cap, before the body is read.
 *
 * Admission control runs as middleware, so it decides before anything knows how
 * many days were asked for. It therefore reserves the WORST CASE — the schema's
 * maximum of 5 days, plus the planner call.
 *
 * Pessimistic on purpose, exactly like `ESTIMATED_TURN_COST_USD`. Reserving too
 * little lets concurrent requests slip past a cap that thinks it has room;
 * reserving too much only makes a user briefly look closer to their limit than
 * they are, and the lease is released the moment the real cost is known. Wrong
 * in the cheap direction.
 */
const MAX_PLAN_UNITS = 6;

planRoutes.post("/stream", requireAuth, enforceLimitsFor(MAX_PLAN_UNITS), async (c) => {
  const user = c.get("user");
  const releaseBudget = c.get("releaseBudget");

  const body = await c.req.json().catch(() => null);
  const parsed = MealPlanRequestSchema.safeParse(body ?? {});

  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request",
        issues: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      },
      400,
    );
  }

  const request = parsed.data;

  // Server-owned evidence, exactly as in the chat route: the client cannot
  // supply the pantry it will be graded against.
  const stored = getPreferences(user.id);
  const pantry = getPantry(user.id);
  const planId = randomUUID();

  return streamSSE(c, async (sse) => {
    // Registered here, not in middleware: `next()` resolves when the stream
    // starts, and a plan runs for ~80 seconds after that. See lifecycle.ts.
    const doneWork = beginWork();

    const send = (event: PlanEvent) => sse.writeSSE({ data: JSON.stringify(event) });

    await send({ type: "plan_start", planId, days: request.days });

    /**
     * Turn ids are opened lazily, one per meal, as generation starts.
     *
     * Not up front: a turn row is a record of a generation, and opening three of
     * them before knowing whether the plan is even feasible would leave two
     * permanently empty rows on every honest refusal — silently deflating the
     * pass rate on /api/stats with generations that never happened.
     */
    const turnIds = new Map<number, string>();

    try {
      const result = await generateMealPlan(
        request,
        {
          pantry,
          dislikes: stored.dislikes,
          dietary: stored.dietary,
          cookware: stored.cookware,
        },
        {
          onPlanning: () => void send({ type: "planning" }),
          onPlan: (allocation, verification) =>
            void send({ type: "plan", allocation, verification }),
          onReplanning: (issues) => void send({ type: "replanning", issues }),
          onMealStart: (day, concept) => void send({ type: "meal_start", day, concept }),
          onDelta: (day, text) => void send({ type: "delta", day, text }),
          onMealDone: (meal) => {
            const turnId =
              turnIds.get(meal.day) ??
              openTurn(user.id, meal.request, {
                userTurn: meal.concept,
                planId,
                planDay: meal.day,
              });
            turnIds.set(meal.day, turnId);

            completeTurn(turnId, {
              recipe: meal.recipe,
              verification: meal.verification,
              ...meal.usage,
              attempts: meal.attempts,
              firstPassOk: meal.firstPassOk,
              firstPassVerification: meal.firstPassVerification,
            });

            void send({ type: "meal_recipe", day: meal.day, recipe: meal.recipe });
            void send({
              type: "meal_verification",
              day: meal.day,
              verification: meal.verification,
              turnId,
            });
          },
          onMealFailed: (failure) => {
            // A failed meal is still a billed meal — record it, or the cost of
            // failure is invisible and the error rate under-reports.
            const turnId = openTurn(
              user.id,
              {
                craving: failure.concept,
                servings: request.servings,
                maxMinutes: request.maxMinutes,
                effort: request.effort,
                willShop: request.willShop,
                pantry,
                dislikes: stored.dislikes,
                dietary: stored.dietary,
                cookware: stored.cookware,
              },
              { userTurn: failure.concept, planId, planDay: failure.day },
            );
            failTurn(
              turnId,
              { code: failure.code, message: failure.message, retryable: false },
              failure.usage,
            );
            void send({
              type: "meal_error",
              day: failure.day,
              message: failure.message,
              code: failure.code,
            });
          },
        },
        { signal: c.req.raw.signal },
      );

      providerBreaker.recordSuccess();

      /**
       * THE HONEST REFUSAL PATH.
       *
       * Reported as its own event rather than an error, because it is a correct
       * answer to a fair question. The alternative — inventing a third dinner —
       * is the single worst thing this feature could do, and the eval suite has
       * adversarial fixtures whose expected outcome is exactly this event.
       */
      if (!result.allocation.feasible) {
        await send({
          type: "infeasible",
          reason:
            result.allocation.infeasibleReason ??
            "There isn't enough in your pantry for that many meals.",
          verification: result.allocationVerification,
        });
      }

      await send({
        type: "plan_done",
        planId,
        mealsDelivered: result.meals.length,
        usage: {
          costUsd: result.totalCostUsd,
          plannerCostUsd: result.plannerUsage.costUsd,
          totalLatencyMs: result.totalLatencyMs,
          model: config.RECIPE_MODEL,
          plannerModel: config.PLAN_MODEL,
        },
      });
    } catch (err) {
      const info = classifyError(err);
      providerBreaker.recordFailure(info);

      const message =
        err instanceof RecipeGenerationError
          ? err.message
          : "Something went wrong building that meal plan.";

      const severity = severityOf(info.code);
      const log =
        severity === "critical" ? console.error : severity === "warning" ? console.warn : console.info;
      log(
        `[plan] ${severity.toUpperCase()} plan ${planId} failed (${info.code}` +
          `${info.status ? ` ${info.status}` : ""}): ${info.message}`,
      );

      await send({ type: "error", message, code: info.code, planId });
    } finally {
      // Both here, not in middleware, for the reason documented in routes/chat.ts
      // and lifecycle.ts: `next()` returned ~80 seconds ago.
      releaseBudget();
      doneWork();
    }
  });
});
