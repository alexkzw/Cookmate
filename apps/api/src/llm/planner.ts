import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  MealPlanAllocationSchema,
  type MealPlanAllocation,
  type MealPlanRequest,
} from "@cookmate/shared";
import { anthropic } from "./client.js";
import { config } from "../config.js";
import { classifyCache, computeCostUsd, type CallUsage, type TokenUsage } from "./models.js";
import { RecipeGenerationError } from "./generate.js";

/**
 * THE PLANNER — the small, hard call.
 *
 * This is the only genuinely difficult reasoning in the meal-plan feature:
 * dividing a fixed set of ingredients into N coherent dinners without
 * double-spending the protein. Writing the actual recipe afterwards is the easy
 * part, and the existing single-recipe path already does it well.
 *
 * SO THE EXPENSIVE MODEL GOES ON THE SMALL CALL, which inverts the intuition
 * that the big model belongs on the big job. The economics make the case:
 *
 *   planner      ~1,200 in / ~400 out   — hard reasoning, tiny output
 *   each recipe  ~1,500 in / ~3,000 out — easy writing, large output
 *
 * At Opus rates the planner costs roughly $0.016; running all three recipe
 * generations on Opus instead of Sonnet would add roughly $0.03 for output the
 * eval says Sonnet already produces at parity (36/36 with repair). Paying
 * premium rates on 400 tokens of reasoning and commodity rates on 9,000 tokens
 * of prose is the whole trade, and it is only available because the two jobs
 * were separated in the first place.
 *
 * `PLAN_MODEL` is config, not code, for the same reason `RECIPE_MODEL` is: the
 * claim above is a measurement, and a measurement can be re-run.
 */

/**
 * Frozen, like SYSTEM_PROMPT and for the same reason — it is the cached prefix.
 *
 * Nothing volatile may be interpolated here. The pantry, the day count and the
 * note all render in the user turn, after the breakpoint.
 */
export const PLANNER_SYSTEM_PROMPT = `You are the meal planner for Cookmate. You are given one person's pantry and asked to divide it into several distinct dinners they could cook over the coming days.

This is an allocation problem, not a recipe-writing problem. You decide WHAT GOES WHERE. Someone else writes the recipes.

## The scarcity rule — the whole job

Assume the user owns exactly ONE of each thing they listed. One packet of chicken thighs, one salmon fillet, one block of tofu.

That means a substantial ingredient can anchor only ONE meal. If you put the chicken in Monday's dinner, it is gone — Tuesday cannot have it too. This is the constraint that makes the task real, and it is checked programmatically after you answer.

Everyday items are the exception and may appear in every meal: onions, garlic, ginger, herbs, spices, oil, rice, pasta, flour, stock, soy sauce, fish sauce, vinegar, condiments. Nobody rations an onion.

## Claiming ingredients

Copy pantry entries VERBATIM into claimedPantry. If the pantry says "chicken thighs", write "chicken thighs" — not "chicken", not "chicken thigh fillets". Claims are matched against the real pantry and anything that does not resolve is reported as an invented ingredient.

Never claim something that is not on the list. You are not allowed to assume the user has anything they did not tell you about, beyond basic seasonings.

## Making the meals worth eating

Each meal needs a reason to exist. Give every day something substantial of its own where the pantry allows it, and vary the cuisines and techniques — three stir fries is a failure even if the arithmetic works.

Leftovers are fine. You do not have to use everything, and a plan that uses eight of twelve items well is better than one that forces all twelve in.

Write each meal's "craving" as a natural brief to a cook: what to make, and why these ingredients. That line is handed straight to the recipe writer.

## Saying no

If the pantry genuinely cannot support the number of distinct meals requested — one protein and nothing else substantial, or so little that two of the days would be an onion and some rice — set feasible to false, explain what is missing in infeasibleReason, and return an empty meals array.

Refusing is a correct answer and it is better than the alternative. Do not invent ingredients to make a plan fit, and do not pad the days with meals nobody would want to eat. A user told honestly that they have two dinners' worth of food can go to the shop; a user given three fictional dinners discovers the problem at the stove.`;

/** Everything volatile. Rendered after the cache breakpoint. */
export function buildPlannerTurn(
  request: MealPlanRequest,
  pantry: string[],
  dislikes: string[],
  dietary: string[],
): string {
  const lines: string[] = [];
  lines.push(`Plan ${request.days} distinct dinners.`);
  lines.push(`Servings per meal: ${request.servings}`);
  lines.push(`Maximum time per meal: ${request.maxMinutes} minutes`);
  lines.push(`Effort level: ${request.effort}`);
  lines.push(
    request.willShop
      ? `Willing to shop: yes — but the plan should still be built around the pantry.`
      : `Willing to shop: NO — every meal must come from the pantry below plus basic seasonings. This is a hard constraint.`,
  );

  if (request.note.trim().length > 0) {
    lines.push("");
    lines.push(`Extra steer from the user: ${request.note.trim()}`);
  }

  lines.push("");
  if (pantry.length > 0) {
    lines.push(`Pantry — the ONLY things they are known to have (one of each):`);
    for (const item of pantry) lines.push(`- ${item}`);
  } else {
    lines.push(`Pantry: EMPTY. They have told us nothing. This cannot support a plan.`);
  }

  if (dislikes.length > 0) {
    lines.push("");
    lines.push(`Dislikes (must not appear at all): ${dislikes.join(", ")}`);
  }
  if (dietary.length > 0) {
    lines.push("");
    lines.push(`Dietary requirements (absolute): ${dietary.join(", ")}`);
  }

  return lines.join("\n");
}

export interface PlanResult {
  allocation: MealPlanAllocation;
  usage: CallUsage;
}

function summarise(message: Anthropic.Message, model: string, startedAt: number): CallUsage {
  const tokens: TokenUsage = {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
  return {
    ...tokens,
    costUsd: computeCostUsd(model, tokens),
    cacheStatus: classifyCache(tokens),
    model,
    effort: config.PLAN_EFFORT,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Ask for an allocation.
 *
 * NOT STREAMED, deliberately. There is nothing useful to show a user mid-plan —
 * a half-built allocation is not readable, and the verdict on it is not known
 * until it is complete. The UI says "working out how to split your pantry" for
 * ~5 seconds and then shows a checked plan, which is more honest than streaming
 * tokens that might be about to be thrown away by the verifier.
 */
export async function planMeals(
  request: MealPlanRequest,
  pantry: string[],
  dislikes: string[],
  dietary: string[],
  options: { signal?: AbortSignal; userTurnOverride?: string } = {},
): Promise<PlanResult> {
  const startedAt = Date.now();
  const model = config.PLAN_MODEL;

  const message = await anthropic.messages.create(
    {
      model,
      max_tokens: 4_000,
      system: [
        {
          type: "text",
          text: PLANNER_SYSTEM_PROMPT,
          // Same 1h TTL as the recipe path. The planner prompt is frozen, so
          // every plan in an hour reads this prefix instead of writing it.
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      output_config: {
        effort: config.PLAN_EFFORT,
        format: zodOutputFormat(MealPlanAllocationSchema),
      },
      messages: [
        {
          role: "user",
          content:
            options.userTurnOverride ?? buildPlannerTurn(request, pantry, dislikes, dietary),
        },
      ],
    },
    { signal: options.signal },
  );

  const usage = summarise(message, model, startedAt);

  if (message.stop_reason === "refusal") {
    throw new RecipeGenerationError("The model declined to plan this.", "refusal", usage);
  }
  if (message.stop_reason === "max_tokens") {
    throw new RecipeGenerationError("The plan was cut off before it finished.", "truncated", usage);
  }

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (!text.trim()) {
    throw new RecipeGenerationError("The planner returned an empty response.", "empty_response", usage);
  }

  try {
    return { allocation: MealPlanAllocationSchema.parse(JSON.parse(text)), usage };
  } catch (err) {
    throw new RecipeGenerationError(
      `Planner output did not match the allocation schema: ${err instanceof Error ? err.message : String(err)}`,
      "schema_mismatch",
      usage,
    );
  }
}

/**
 * Content hash of the planner prompt, recorded on every plan.
 *
 * Same argument as `promptHash()`: without it, plans from before and after a
 * prompt edit are indistinguishable rows, and any change in the infeasible-rate
 * or the double-allocation rate is unattributable.
 */
export function plannerPromptHash(): string {
  return createHash("sha256").update(PLANNER_SYSTEM_PROMPT).digest("hex").slice(0, 8);
}
