import { z } from "zod";
import { RecipeSchema } from "./recipe.js";
import { VerificationSchema } from "./constraints.js";

/**
 * THE MEAL PLAN — constraint satisfaction over a SHARED resource.
 *
 * Every other feature in this app verifies one recipe against one pantry. This
 * one verifies that N recipes TOGETHER fit one pantry, which is a different and
 * strictly harder question: three recipes can each be individually legal and
 * still be jointly impossible, because all three planned to use the same chicken
 * thighs.
 *
 * ARCHITECTURE: PLAN, THEN GENERATE. Two stages, and the split is the point.
 *
 *   1. A PLANNER decides which pantry items go to which meal. This is the hard
 *      reasoning and it is CHEAP to get wrong — the output is a few hundred
 *      tokens, so a rejected plan costs cents, not dollars.
 *   2. A deterministic verifier checks the allocation is actually feasible.
 *   3. Only then does each meal get generated, against its allocated subset,
 *      through the existing single-recipe path — unchanged.
 *
 * The alternative designs and why they lost:
 *
 *   ONE CALL, THREE RECIPES — the model sees the whole allocation at once and
 *   can balance it, but one bad recipe means regenerating all three, the output
 *   is 3x the tokens in a single response (more truncation risk), and nothing is
 *   checkable until everything has been paid for.
 *
 *   THREE SEQUENTIAL CALLS, pantry shrinking as it goes — reuses the existing
 *   path with no new concepts, but it is GREEDY: meal one takes the only protein
 *   and meals two and three are left with onions. No global view, and the
 *   failure arrives after you have already paid for meal one.
 *
 * Plan-then-generate is the only one of the three where the expensive work is
 * gated on a check that runs BEFORE the expensive work. That is the same shape
 * as the rest of this codebase: the verifier is a controller, not a reporter.
 */

/**
 * One meal in the plan, as the PLANNER proposes it.
 *
 * Deliberately not a Recipe. The planner's job is allocation, not cooking — it
 * decides what goes where, and the recipe generator decides what to do with it.
 * Asking one call to do both is how you get a plan you cannot check until the
 * whole thing has been written.
 */
export const MealSlotSchema = z
  .object({
    day: z.number().describe("1-indexed day this meal is for"),
    concept: z.string().describe("Short description of the dish, e.g. 'ginger chicken stir fry'"),
    cuisine: z.string().describe("e.g. Thai, Italian, Mexican"),
    /**
     * The craving line handed to the recipe generator for this meal.
     *
     * Written by the planner rather than assembled in code, because the planner
     * is the only thing that knows why it put these items together — "use the
     * chicken thighs and the ginger before they turn" is a better brief than any
     * template could produce from the item list alone.
     */
    craving: z.string().describe("A natural request to hand the recipe writer for this meal"),
    /**
     * Pantry items this meal claims.
     *
     * THE MODEL'S CLAIM, NOT THE TRUTH. Every entry is checked against the real
     * pantry by `verifyAllocation` — a claim on something the user does not own
     * is exactly the hallucination this feature is most likely to produce, and
     * exactly the one the eval's adversarial fixtures are built to catch.
     */
    claimedPantry: z
      .array(z.string())
      .describe("Pantry items, copied verbatim from the pantry list, that this meal uses"),
  })
  .strict();
export type MealSlot = z.infer<typeof MealSlotSchema>;

/**
 * The planner's whole output.
 *
 * `feasible` exists so the model has a way to say NO. Without it the only
 * available behaviour when a pantry cannot support three meals is to invent
 * ingredients, which is the failure mode that would most damage the product's
 * central claim. A refusal is a legitimate, checkable answer — and "does it
 * correctly refuse" is a thing the eval suite can measure, because we can build
 * a pantry that genuinely cannot stretch.
 */
export const MealPlanAllocationSchema = z
  .object({
    feasible: z
      .boolean()
      .describe(
        "True only if the pantry can genuinely support the requested number of distinct meals. If it cannot, set false and explain — never invent ingredients to make it fit.",
      ),
    infeasibleReason: z
      .string()
      .nullable()
      .describe("When feasible is false, what is missing. Null otherwise."),
    meals: z.array(MealSlotSchema).describe("One entry per day. Empty when feasible is false."),
    /** Items deliberately left unallocated. Not a failure — leftovers are normal. */
    leftovers: z
      .array(z.string())
      .describe("Pantry items not used by any meal. An empty array is fine."),
  })
  .strict();
export type MealPlanAllocation = z.infer<typeof MealPlanAllocationSchema>;

/**
 * What the ALLOCATION verifier can find. Distinct from `Violation` in
 * constraints.ts, which is about one recipe against one request — these are
 * about the plan as a whole, and they are found before a single recipe exists.
 */
export const AllocationViolationSchema = z
  .object({
    kind: z.enum([
      /** An exclusive item (the chicken) claimed by more than one meal. */
      "double_allocated",
      /** Claimed something that is not in the pantry at all — a hallucination. */
      "phantom_ingredient",
      /** A meal with nothing substantive of its own. */
      "empty_meal",
      /** Wrong number of meals, or duplicate/missing day numbers. */
      "malformed_plan",
      /** Said it was feasible and then didn't plan, or vice versa. */
      "inconsistent_feasibility",
    ]),
    detail: z.string(),
    subject: z.string().nullable(),
  })
  .strict();
export type AllocationViolation = z.infer<typeof AllocationViolationSchema>;

export const AllocationVerificationSchema = z
  .object({
    ok: z.boolean(),
    violations: z.array(AllocationViolationSchema),
    /**
     * Which pantry items this verifier treated as SCARCE, and which as shareable.
     *
     * Reported rather than merely used, because it is a judgement the user can
     * disagree with — "I have three onions" is a reasonable objection, and it is
     * only answerable if the app says out loud which items it rationed.
     */
    exclusiveItems: z.array(z.string()),
    sharedItems: z.array(z.string()),
    /** Recomputed by us, never taken from the planner's `leftovers` field. */
    unclaimedPantry: z.array(z.string()),
    mealsPlanned: z.number(),
  })
  .strict();
export type AllocationVerification = z.infer<typeof AllocationVerificationSchema>;

/** What the user asked for. Extends a single cook request with a day count. */
export const MealPlanRequestSchema = z
  .object({
    days: z.number().int().min(2).max(5).default(3),
    servings: z.number().int().min(1).max(12).default(2),
    maxMinutes: z.number().int().min(5).max(240).default(40),
    effort: z.enum(["minimal", "moderate", "project"]).default("moderate"),
    /**
     * Defaults to FALSE here, unlike a single recipe.
     *
     * The whole point of a plan is "what can I make from what I already have".
     * Allowing shopping by default would let the planner sidestep the scarcity
     * that makes the problem interesting — and makes the constraint real.
     */
    willShop: z.boolean().default(false),
    /** Free-text steer: "something light on day three". Optional. */
    note: z.string().max(500).default(""),
  })
  .strict();
export type MealPlanRequest = z.infer<typeof MealPlanRequestSchema>;

/**
 * The SSE protocol for a plan.
 *
 * A separate union from `StreamEvent` rather than an extension of it. The two
 * streams answer different questions — one recipe arriving, versus a plan and
 * then N recipes arriving — and merging them would give the client one switch
 * where half the cases are unreachable on any given route.
 *
 * Every per-meal event carries `day`, because meals arrive over ~80 seconds and
 * the client needs to know which card to write into without relying on order.
 */
export const PlanEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan_start"), planId: z.string(), days: z.number() }),
  /** The planner call is running. ~5s, and the UI should say what it is doing. */
  z.object({ type: z.literal("planning") }),
  z.object({
    type: z.literal("plan"),
    allocation: MealPlanAllocationSchema,
    verification: AllocationVerificationSchema,
  }),
  /**
   * The allocation failed verification and we are asking for a new one.
   *
   * Re-planning is CHEAP — it happens before any recipe has been generated, so
   * nothing is thrown away except a few hundred planner tokens. Contrast
   * `meal_error`, which arrives after real money has been spent on that meal.
   */
  z.object({ type: z.literal("replanning"), issues: z.array(z.string()) }),
  /**
   * The pantry genuinely cannot support the requested number of meals.
   *
   * A first-class outcome, not an error. The alternative to saying this is
   * inventing ingredients, and an app whose entire claim is "you can cook this
   * tonight" must be able to say "not three nights, no".
   */
  z.object({
    type: z.literal("infeasible"),
    reason: z.string(),
    verification: AllocationVerificationSchema,
  }),
  z.object({ type: z.literal("meal_start"), day: z.number(), concept: z.string() }),
  z.object({ type: z.literal("delta"), day: z.number(), text: z.string() }),
  z.object({ type: z.literal("meal_recipe"), day: z.number(), recipe: RecipeSchema }),
  z.object({
    type: z.literal("meal_verification"),
    day: z.number(),
    verification: VerificationSchema,
    turnId: z.string(),
  }),
  /**
   * One meal failed. The plan CONTINUES.
   *
   * Two meals a user can cook beat a clean failure, and the two that already
   * succeeded have already been paid for — abandoning them on the third's
   * failure would bill for work it then threw away.
   */
  z.object({
    type: z.literal("meal_error"),
    day: z.number(),
    message: z.string(),
    code: z.string(),
  }),
  z.object({
    type: z.literal("plan_done"),
    planId: z.string(),
    mealsDelivered: z.number(),
    usage: z.object({
      costUsd: z.number(),
      plannerCostUsd: z.number(),
      totalLatencyMs: z.number(),
      model: z.string(),
      plannerModel: z.string(),
    }),
  }),
  z.object({ type: z.literal("error"), message: z.string(), code: z.string(), planId: z.string() }),
]);
export type PlanEvent = z.infer<typeof PlanEventSchema>;
