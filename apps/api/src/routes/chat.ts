import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { CookRequestSchema, type CookRequest, type StreamEvent } from "@cookmate/shared";
import { requireAuth } from "../auth.js";
import { enforceLimits } from "../limits/middleware.js";
import { getPantry, getPreferences } from "../db/index.js";
import { RecipeGenerationError } from "../llm/generate.js";
import { generateVerifiedRecipe } from "../llm/verified.js";
import { classifyError } from "../llm/errors.js";
import { openTurn, completeTurn, failTurn, conversationHistory } from "../telemetry/turns.js";
import { buildUserTurn } from "../llm/prompts.js";

export const chatRoutes = new Hono();

/**
 * POST /api/chat/stream — Server-Sent Events.
 *
 * The response is deliberately two-phase, and the UI mirrors it:
 *
 *   delta…delta…delta   the model's JSON streaming in, so the card fills live
 *   recipe              the parsed, schema-valid object
 *   verification        our deterministic check — arrives AFTER the recipe,
 *                       because it can only run once the recipe exists
 *   done                usage, cost, cache status, latency
 *
 * Showing the verification resolve a beat after the recipe is honest about the
 * architecture, and it's the moment the product's actual claim gets made.
 */
chatRoutes.post("/stream", requireAuth, enforceLimits, async (c) => {
  const user = c.get("user");
  // Claimed by enforceLimits before the model was called; released below once
  // the real cost is recorded, so the estimate stops mattering immediately.
  const releaseBudget = c.get("releaseBudget");

  const body = await c.req.json().catch(() => null);

  // Pantry, dislikes and dietary needs are server-owned state — they are the
  // evidence the recipe gets grounded against, so the client cannot supply or
  // override them. Omitting them from the inbound schema entirely (rather than
  // marking them optional) is deliberate: `.partial()` does NOT strip a field's
  // `.default([])`, so an "optional" pantry parses to `[]` rather than
  // `undefined` and silently defeats a `?? fromDatabase` fallback.
  const InboundSchema = CookRequestSchema.omit({
    pantry: true,
    dislikes: true,
    dietary: true,
    cookware: true,
  }).extend({
    /**
     * The turn this one continues. When present, `craving` is read as a
     * follow-up ("make it faster", "swap the chicken") rather than a fresh ask,
     * and the prior conversation is replayed to the model.
     *
     * Follow-ups still return a full, freshly verified Recipe — they are
     * re-generations with an added constraint, not chat. That keeps every claim
     * the verifier makes true on turn five as well as turn one.
     */
    followUpTo: z.string().min(1).max(64).optional(),
  });
  const parsed = InboundSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request",
        issues: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      },
      400,
    );
  }

  const { followUpTo, ...cookFields } = parsed.data;
  const stored = getPreferences(user.id);
  const request: CookRequest = {
    ...cookFields,
    pantry: getPantry(user.id),
    dislikes: stored.dislikes,
    dietary: stored.dietary,
    cookware: stored.cookware,
  };

  // Scoped to this user inside conversationHistory — an unguessable turn id is
  // not an authorisation model, and history is the most sensitive thing stored.
  const history = followUpTo ? conversationHistory(user.id, followUpTo) : [];
  if (followUpTo && history.length === 0) {
    return c.json({ error: "That conversation is no longer available.", code: "unknown_turn" }, 404);
  }

  // Rendered once, here, and recorded — so "the model ignored the pantry" and
  // "the pantry never reached the model" stay distinguishable after the fact.
  const userTurn = buildUserTurn(request);
  const turnId = openTurn(user.id, request, { userTurn, parentTurnId: followUpTo ?? null });

  return streamSSE(c, async (sse) => {
    const send = (event: StreamEvent) => sse.writeSSE({ data: JSON.stringify(event) });

    await send({ type: "start", turnId });

    try {
      const { recipe, usage, verification, attempts, firstPassOk, firstPassVerification } =
        await generateVerifiedRecipe(
          request,
          (text) => {
            // Fire-and-forget: backpressure on token deltas would stall generation.
            void send({ type: "delta", text });
          },
          {
            repair: true,
            history,
            signal: c.req.raw.signal,
            // The first recipe has already streamed to the browser, so a silent
            // second attempt would look like a stall. Say what's happening.
            onRepairStart: (issues) => void send({ type: "repairing", issues }),
          },
        );

      await send({ type: "recipe", recipe });
      await send({ type: "verification", verification });

      completeTurn(turnId, {
        recipe,
        verification,
        ...usage,
        attempts,
        firstPassOk,
        firstPassVerification,
      });

      await send({
        type: "done",
        turnId,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          costUsd: usage.costUsd,
          cacheStatus: usage.cacheStatus,
          model: usage.model,
          latencyMs: usage.latencyMs,
        },
      });
    } catch (err) {
      const code = err instanceof RecipeGenerationError ? err.code : "internal_error";
      const message =
        err instanceof RecipeGenerationError
          ? err.message
          : "Something went wrong generating that recipe.";
      // A failed generation is still a billed generation — carry its usage into
      // the turn log so the cost of failure is visible, not just its existence.
      const usage = err instanceof RecipeGenerationError ? err.usage : undefined;
      failTurn(turnId, classifyError(err), usage);
      console.error(`[chat] turn ${turnId} failed (${code}):`, err);
      await send({ type: "error", message, code });
    } finally {
      // Must be here, not in the middleware. `next()` returns when the stream
      // STARTS, so releasing there would free the budget ~26 seconds before the
      // call it is accounting for actually finishes — reopening exactly the
      // concurrency hole the reservation exists to close.
      releaseBudget();
    }
  });
});
