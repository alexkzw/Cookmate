import type {
  AllocationVerification,
  CookRequest,
  MealPlanAllocation,
  MealPlanRequest,
  Recipe,
  Verification,
} from "@cookmate/shared";
import { verifyAllocation, pantryForMeal } from "../verify/allocation.js";
import { planMeals } from "./planner.js";
import { generateVerifiedRecipe } from "./verified.js";
import { RecipeGenerationError } from "./generate.js";
import type { CallUsage } from "./models.js";

/**
 * THE MEAL PLAN ORCHESTRATOR — plan, check, then generate.
 *
 * The control flow here encodes the feature's three real design decisions. They
 * are written down because each had a plausible alternative that is wrong for a
 * reason worth remembering.
 *
 * ── WHERE TO REPAIR ──────────────────────────────────────────────────────────
 * Two things can fail, at two different prices, and they get opposite handling:
 *
 *   THE ALLOCATION fails  → RE-PLAN the whole thing. It costs a few hundred
 *     tokens and nothing downstream has been paid for yet. Re-planning is
 *     almost free here, and a coherent new plan beats patching a broken one.
 *
 *   ONE RECIPE fails      → REPAIR THAT RECIPE ONLY. Never re-plan. By this
 *     point the allocation has already been verified feasible, so a recipe that
 *     breaks its constraints is a GENERATION fault, not a PLANNING fault — and
 *     re-planning would throw away the meals that already succeeded, along with
 *     the ~$0.05 each of them cost.
 *
 * The rule generalises: REPAIR AT THE LAYER THAT BROKE. Escalating a local
 * failure to a global retry is how a system ends up paying repeatedly for work
 * that was never wrong.
 *
 * ── WHAT HAPPENS WHEN ONE MEAL DIES ──────────────────────────────────────────
 * The plan continues. Two dinners a user can actually cook are worth more than a
 * clean failure, and the two that already succeeded have already been billed —
 * abandoning them would charge for work and then discard it.
 *
 * ── SEQUENTIAL, NOT PARALLEL ─────────────────────────────────────────────────
 * Three concurrent generations would finish in ~30s instead of ~80s, and it is
 * still wrong here: it triples peak spend against a cap that is checked once at
 * admission, it makes the circuit breaker's view of the provider three times
 * noisier, and the user cannot read three recipes at once anyway. The latency is
 * paid down by STREAMING each meal as it lands (see routes/plan.ts), which gets
 * the first recipe on screen at ~26s — the same moment a single recipe would
 * have arrived.
 */

/** Bounded exactly like the repair loop, and for the same reason. */
const MAX_PLAN_ATTEMPTS = 2;

export interface PlannedMeal {
  day: number;
  concept: string;
  recipe: Recipe;
  verification: Verification;
  usage: CallUsage;
  firstPassOk: boolean;
  firstPassVerification: Verification;
  attempts: number;
  /** The narrowed pantry this meal was actually generated against. */
  request: CookRequest;
}

export interface FailedMeal {
  day: number;
  concept: string;
  code: string;
  message: string;
  usage?: CallUsage;
}

export interface MealPlanResult {
  allocation: MealPlanAllocation;
  allocationVerification: AllocationVerification;
  /** Empty when the planner correctly refused — check `allocation.feasible`. */
  meals: PlannedMeal[];
  failures: FailedMeal[];
  plannerUsage: CallUsage;
  /** Planner + every generation, summed. What the whole plan actually cost. */
  totalCostUsd: number;
  totalLatencyMs: number;
  /** How many planner calls it took to produce a verifiable allocation. */
  planAttempts: number;
}

export interface PlanCallbacks {
  onPlanning?: () => void;
  onPlan?: (allocation: MealPlanAllocation, verification: AllocationVerification) => void;
  onReplanning?: (issues: string[]) => void;
  onMealStart?: (day: number, concept: string) => void;
  onDelta?: (day: number, text: string) => void;
  onMealDone?: (meal: PlannedMeal) => void;
  onMealFailed?: (failure: FailedMeal) => void;
  onRepairStart?: (day: number, issues: string[]) => void;
}

/**
 * Ask the planner until the allocation verifies, bounded.
 *
 * The retry sends the verifier's findings back the same way the recipe repair
 * loop does — a precise itemised description of what was wrong beats sampling
 * again and hoping, because the failure ("you gave the chicken to two days") is
 * specific and actionable rather than random.
 */
async function planUntilValid(
  request: MealPlanRequest,
  pantry: string[],
  dislikes: string[],
  dietary: string[],
  callbacks: PlanCallbacks,
  signal?: AbortSignal,
): Promise<{
  allocation: MealPlanAllocation;
  verification: AllocationVerification;
  usage: CallUsage;
  attempts: number;
}> {
  callbacks.onPlanning?.();

  let last = await planMeals(request, pantry, dislikes, dietary, { signal });
  let verification = verifyAllocation(last.allocation, pantry, request.days);
  let totalCost = last.usage.costUsd;
  let totalLatency = last.usage.latencyMs;
  let attempts = 1;

  while (!verification.ok && attempts < MAX_PLAN_ATTEMPTS) {
    const issues = verification.violations.map((v) => v.detail);
    callbacks.onReplanning?.(issues);

    const retry = await planMeals(request, pantry, dislikes, dietary, {
      signal,
      userTurnOverride: buildReplanTurn(request, pantry, dislikes, dietary, last.allocation, issues),
    });
    attempts += 1;
    totalCost += retry.usage.costUsd;
    totalLatency += retry.usage.latencyMs;

    last = retry;
    verification = verifyAllocation(retry.allocation, pantry, request.days);
  }

  return {
    allocation: last.allocation,
    verification,
    // Cost and latency are the TOTALS across attempts — what the plan actually
    // cost, not what the last call cost. A retry that vanished from the bill
    // would make the cheap-to-re-plan claim unfalsifiable.
    usage: { ...last.usage, costUsd: totalCost, latencyMs: totalLatency },
    attempts,
  };
}

/**
 * The re-plan prompt: the original brief, the rejected plan, and what was wrong.
 *
 * Built here rather than in planner.ts because it is control flow, not prompt
 * content — and it goes in the user turn, after the cache breakpoint, so the
 * frozen planner prompt stays byte-identical and the retry READS the prefix the
 * first attempt wrote instead of paying to write a new one.
 */
function buildReplanTurn(
  request: MealPlanRequest,
  pantry: string[],
  dislikes: string[],
  dietary: string[],
  rejected: MealPlanAllocation,
  issues: string[],
): string {
  const lines: string[] = [];
  lines.push(`Your previous plan was rejected by the allocation checker.`);
  lines.push("");
  lines.push(`What was wrong:`);
  for (const issue of issues) lines.push(`- ${issue}`);
  lines.push("");
  lines.push(`The plan you produced:`);
  lines.push(JSON.stringify(rejected, null, 2));
  lines.push("");
  lines.push(
    `Produce a corrected plan. Remember: one of each pantry item, so a substantial ingredient can anchor only one meal. If the pantry genuinely cannot support ${request.days} meals, say so with feasible: false rather than forcing it.`,
  );
  lines.push("");
  lines.push(`The original brief again:`);
  lines.push("");

  // Re-render the original brief verbatim so the retry is answering the same
  // question, not a summary of it.
  lines.push(buildOriginalBrief(request, pantry, dislikes, dietary));
  return lines.join("\n");
}

function buildOriginalBrief(
  request: MealPlanRequest,
  pantry: string[],
  dislikes: string[],
  dietary: string[],
): string {
  const lines: string[] = [];
  lines.push(`Plan ${request.days} distinct dinners.`);
  lines.push(`Servings per meal: ${request.servings}`);
  lines.push(`Maximum time per meal: ${request.maxMinutes} minutes`);
  lines.push(`Pantry (one of each):`);
  for (const item of pantry) lines.push(`- ${item}`);
  if (dislikes.length > 0) lines.push(`Dislikes: ${dislikes.join(", ")}`);
  if (dietary.length > 0) lines.push(`Dietary: ${dietary.join(", ")}`);
  return lines.join("\n");
}

export async function generateMealPlan(
  request: MealPlanRequest,
  context: { pantry: string[]; dislikes: string[]; dietary: string[]; cookware: CookRequest["cookware"] },
  callbacks: PlanCallbacks = {},
  options: { signal?: AbortSignal } = {},
): Promise<MealPlanResult> {
  const startedAt = Date.now();
  const { pantry, dislikes, dietary, cookware } = context;

  const planned = await planUntilValid(
    request,
    pantry,
    dislikes,
    dietary,
    callbacks,
    options.signal,
  );

  callbacks.onPlan?.(planned.allocation, planned.verification);

  /**
   * A plan that still does not verify after its retry is a hard stop.
   *
   * Generating from a broken allocation would produce exactly the failure this
   * whole feature exists to prevent — three dinners quietly built on one packet
   * of chicken — and it would cost ~$0.14 to produce it. Refusing is both
   * cheaper and more honest.
   */
  if (!planned.verification.ok) {
    throw new RecipeGenerationError(
      `The planner could not produce a workable split of your pantry: ${planned.verification.violations
        .map((v) => v.detail)
        .join(" ")}`,
      "allocation_failed",
      planned.usage,
    );
  }

  const base: MealPlanResult = {
    allocation: planned.allocation,
    allocationVerification: planned.verification,
    meals: [],
    failures: [],
    plannerUsage: planned.usage,
    totalCostUsd: planned.usage.costUsd,
    totalLatencyMs: 0,
    planAttempts: planned.attempts,
  };

  // An honest refusal. Not an error — the caller reports it as its own outcome,
  // and the eval suite scores it as a PASS on the adversarial fixtures.
  if (!planned.allocation.feasible) {
    return { ...base, totalLatencyMs: Date.now() - startedAt };
  }

  const meals: PlannedMeal[] = [];
  const failures: FailedMeal[] = [];
  let totalCostUsd = planned.usage.costUsd;

  // Sorted so days arrive in order even if the planner emitted them shuffled.
  const slots = [...planned.allocation.meals].sort((a, b) => a.day - b.day);

  for (const slot of slots) {
    callbacks.onMealStart?.(slot.day, slot.concept);

    /**
     * The narrowed pantry is what enforces the allocation.
     *
     * This meal sees only the exclusive items it was given, plus everything
     * shareable. Combined with `willShop: false`, any ingredient outside that
     * set is recomputed as `shopping` by the recipe verifier and becomes a
     * violation — so a recipe that drifts off its brief is caught by a checker
     * that knows nothing about meal plans.
     */
    const mealRequest: CookRequest = {
      craving: slot.craving,
      servings: request.servings,
      maxMinutes: request.maxMinutes,
      effort: request.effort,
      willShop: request.willShop,
      pantry: pantryForMeal(slot.claimedPantry, pantry),
      dislikes,
      dietary,
      cookware,
    };

    try {
      const generated = await generateVerifiedRecipe(
        mealRequest,
        (text) => callbacks.onDelta?.(slot.day, text),
        {
          repair: true,
          signal: options.signal,
          onRepairStart: (issues) => callbacks.onRepairStart?.(slot.day, issues),
        },
      );

      totalCostUsd += generated.usage.costUsd;
      const meal: PlannedMeal = {
        day: slot.day,
        concept: slot.concept,
        recipe: generated.recipe,
        verification: generated.verification,
        usage: generated.usage,
        firstPassOk: generated.firstPassOk,
        firstPassVerification: generated.firstPassVerification,
        attempts: generated.attempts,
        request: mealRequest,
      };
      meals.push(meal);
      callbacks.onMealDone?.(meal);
    } catch (err) {
      /**
       * One meal down, keep going.
       *
       * An abort is the exception: the user closed the tab or pressed stop, so
       * continuing would spend their money on recipes nobody is waiting for.
       */
      if (options.signal?.aborted) throw err;

      const code = err instanceof RecipeGenerationError ? err.code : "internal_error";
      const usage = err instanceof RecipeGenerationError ? err.usage : undefined;
      if (usage) totalCostUsd += usage.costUsd;

      const failure: FailedMeal = {
        day: slot.day,
        concept: slot.concept,
        code,
        message:
          err instanceof RecipeGenerationError
            ? err.message
            : "Something went wrong generating this meal.",
        usage,
      };
      failures.push(failure);
      callbacks.onMealFailed?.(failure);
    }
  }

  return {
    ...base,
    meals,
    failures,
    totalCostUsd,
    totalLatencyMs: Date.now() - startedAt,
  };
}
