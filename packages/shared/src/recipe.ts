import { z } from "zod";

/**
 * The recipe schema is the single most important artifact in this codebase.
 *
 * It is consumed at three separate boundaries, all from this one definition:
 *   1. Model boundary  — compiled to a JSON Schema and handed to Anthropic's
 *                        structured-output support, so the model *cannot* emit
 *                        a shape we can't parse.
 *   2. Server boundary — `RecipeSchema.parse()` before anything is persisted
 *                        or verified.
 *   3. Render boundary — `z.infer<typeof RecipeSchema>` types the React
 *                        components that draw the recipe card.
 *
 * Keeping these in sync by hand (the situation you get with a Python backend
 * and a TypeScript frontend) is the drift bug this project most needs to avoid,
 * because "the output matches the requested constraints" IS the product claim.
 *
 * Structured-output schema constraints (Anthropic): no recursive schemas, no
 * numeric min/max, no string minLength/maxLength, and every object needs
 * `additionalProperties: false`. Zod's `.strict()` gives us the last one; we
 * deliberately avoid `.min()/.max()` on fields sent to the model and enforce
 * those bounds in the verifier instead, where we can produce a useful message.
 */

export const UNITS = [
  "g",
  "kg",
  "ml",
  "l",
  "tsp",
  "tbsp",
  "cup",
  "piece",
  "clove",
  "slice",
  "pinch",
  "to_taste",
] as const;
export const UnitSchema = z.enum(UNITS);
export type Unit = z.infer<typeof UnitSchema>;

/**
 * `source` is the grounding field — the whole point of the app.
 *
 * "pantry"  — the user told us they have this. Free.
 * "staple"  — assumed present in any kitchen (salt, pepper, oil, water).
 *             Configurable per user later; a fixed list for now.
 * "shopping" — they must buy it. Every one of these is a reason the recipe
 *             might not happen tonight, so we count and surface them.
 *
 * The model fills this in, and then `verifyRecipe()` independently recomputes
 * it. We never trust the model's own grounding claim — same principle as
 * checking a citation rather than believing one.
 */
export const IngredientSourceSchema = z.enum(["pantry", "staple", "shopping"]);
export type IngredientSource = z.infer<typeof IngredientSourceSchema>;

export const IngredientSchema = z
  .object({
    /** Canonical singular name, lowercase: "chicken thigh", not "2 Chicken Thighs". */
    name: z.string().describe("Canonical lowercase ingredient name, singular, no quantity"),
    quantity: z.number().describe("Numeric amount; use 0 with unit 'to_taste' when unmeasured"),
    unit: UnitSchema,
    source: IngredientSourceSchema.describe(
      "Where this comes from: 'pantry' if the user listed it, 'staple' for basics like salt/oil/water, 'shopping' if they must buy it",
    ),
    /** Optional swap so a missing item doesn't kill the recipe. */
    substitute: z
      .string()
      .nullable()
      .describe("A realistic substitution if unavailable, else null"),
  })
  .strict();
export type Ingredient = z.infer<typeof IngredientSchema>;

export const StepSchema = z
  .object({
    number: z.number().describe("1-indexed step order"),
    instruction: z.string().describe("One clear action. No step numbers in the text itself."),
    minutes: z.number().describe("Wall-clock minutes this step takes"),
    /** Lets the UI show which pantry items each step consumes. */
    uses: z.array(z.string()).describe("Ingredient names used in this step"),
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;

export const RecipeSchema = z
  .object({
    title: z.string().describe("Short appetising name, no more than 8 words"),
    summary: z.string().describe("One sentence on why this fits what they asked for"),
    cuisine: z.string().describe("e.g. Thai, Italian, Mexican, fusion"),
    servings: z.number(),
    /**
     * The model reports its own timings; the verifier checks them against the
     * user's stated budget and against the sum of step minutes.
     */
    prepMinutes: z.number(),
    cookMinutes: z.number(),
    difficulty: z.enum(["easy", "medium", "hard"]),
    ingredients: z.array(IngredientSchema),
    steps: z.array(StepSchema),
    /** Shown under the card; keeps the model from padding the steps with tips. */
    tips: z.array(z.string()).describe("Zero to three short practical tips"),
  })
  .strict();
export type Recipe = z.infer<typeof RecipeSchema>;
