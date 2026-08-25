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

/**
 * DISPLAY NAME AND MATCH KEY ARE DIFFERENT FIELDS.
 *
 * They used to be one. `name` had to be canonical ("chicken thigh") so the
 * verifier could match it against the pantry — which cost twice over: the
 * recipe card read like a database row, and matching was still free text,
 * which is where the verifier's false positives came from.
 *
 * Splitting them lets each field do one job. `name` is prose for a human.
 * `matchTerm` is a canonical key the verifier resolves, and because the model
 * emits it explicitly rather than having it inferred from prose, it can be
 * constrained and audited on its own.
 *
 * Backwards compatibility matters here: recipes generated before this field
 * existed are still stored and still replayable, so the verifier falls back to
 * `name` when `matchTerm` is absent rather than failing to resolve them.
 */
export const IngredientSchema = z
  .object({
    /** How it reads on the card: "ripe tomatoes, diced". Prose, for a person. */
    name: z.string().describe("How this reads on the recipe card, e.g. 'ripe tomatoes, diced'"),
    /** The key the verifier matches on: "tomato". Canonical, singular, lowercase. */
    matchTerm: z
      .string()
      .describe(
        "The canonical lowercase singular form of the core ingredient, for programmatic pantry matching. No quantity, no preparation, no adjectives: 'tomato', not 'ripe tomatoes, diced'. Use the specific product where it changes what the item is: 'coconut milk', not 'coconut'.",
      ),
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

/**
 * EQUIPMENT — a closed vocabulary, on purpose.
 *
 * Because this is a Zod enum, structured outputs make it impossible for the
 * model to emit equipment outside this list. That turns verification from
 * fuzzy string matching (which is where the ingredient matcher gets its false
 * positives) into exact set membership. Constrain the vocabulary at the schema
 * and the checker becomes trivially correct.
 */

/** Appliances a kitchen may or may not have. The user ticks these once. */
export const APPLIANCES = [
  "oven",
  "stovetop",
  "microwave",
  "air fryer",
  "grill",
  "slow cooker",
  "pressure cooker",
  "rice cooker",
  "blender",
  "food processor",
  "stand mixer",
  "toaster",
  "kettle",
  "waffle iron",
] as const;

/** Hand tools assumed present in any kitchen — never a reason to reject a recipe. */
export const UNIVERSAL_TOOLS = [
  "knife",
  "chopping board",
  "mixing bowl",
  "saucepan",
  "frying pan",
  "baking tray",
  "colander",
  "grater",
  "whisk",
  "tongs",
  "measuring cup",
] as const;

export const EQUIPMENT = [...APPLIANCES, ...UNIVERSAL_TOOLS] as const;
export const EquipmentSchema = z.enum(EQUIPMENT);
export type Equipment = z.infer<typeof EquipmentSchema>;
export type Appliance = (typeof APPLIANCES)[number];

export const StepSchema = z
  .object({
    number: z.number().describe("1-indexed step order"),
    instruction: z.string().describe("One clear action. No step numbers in the text itself."),
    minutes: z.number().describe("Wall-clock minutes this step takes"),
    /**
     * Hands-off means the cook can walk away: simmering, baking, resting,
     * marinating. The verifier sums these separately so we can honestly say
     * "40 minutes, but only 8 of them hands-on" — which is often the
     * difference between cooking on a weeknight and ordering takeaway.
     */
    handsOff: z
      .boolean()
      .describe("True if the cook can walk away during this step (simmer, bake, rest, marinate)"),
    equipment: z
      .array(EquipmentSchema)
      .describe("Equipment this step requires. Omit anything not genuinely needed."),
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
     * NOTE: there is no `prepMinutes` / `cookMinutes` here, deliberately.
     *
     * The model used to report both and the verifier checked that the step
     * minutes summed to them — which produced `step_time_mismatch`, six of the
     * seven first-pass failures on the eval suite. Repair rarely fixed it,
     * because repair regenerates rather than edits, so it corrected the old
     * arithmetic and drifted into new arithmetic.
     *
     * Total time is now DERIVED from the steps. The mismatch isn't caught, it's
     * unrepresentable — the same move as making `equipment` an enum. Exact
     * arithmetic should never be delegated to a model: asking for it only
     * creates something else to verify.
     */
    difficulty: z.enum(["easy", "medium", "hard"]),
    ingredients: z.array(IngredientSchema),
    steps: z.array(StepSchema),
    /** Shown under the card; keeps the model from padding the steps with tips. */
    tips: z.array(z.string()).describe("Zero to three short practical tips"),
  })
  .strict();
export type Recipe = z.infer<typeof RecipeSchema>;
