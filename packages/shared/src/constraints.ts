import { z } from "zod";
import { EquipmentSchema } from "./recipe.js";

/**
 * What the user asked for. This is the "evidence" the recipe must be grounded
 * against — the cooking-app analogue of retrieved document chunks.
 */

export const EFFORT_LEVELS = ["minimal", "moderate", "project"] as const;

export const CookRequestSchema = z
  .object({
    /** Free text: "something spicy with noodles", "use up the eggplant". */
    craving: z.string().min(1).max(500),
    servings: z.number().int().min(1).max(12).default(2),
    /** Hard ceiling on prep + cook. The most commonly violated constraint. */
    maxMinutes: z.number().int().min(5).max(240).default(30),
    effort: z.enum(EFFORT_LEVELS).default("moderate"),
    /** If false, every ingredient must be pantry or staple. */
    willShop: z.boolean().default(true),
    /**
     * Free-text pantry lines, one item per entry.
     *
     * 120 rather than 80: the tighter bound was reachable in normal use (a
     * comma-separated list typed on one line), and hitting it produced a 400
     * that silently emptied the pantry. Give real entries headroom — the cap
     * exists to stop abuse, not to police phrasing.
     */
    pantry: z.array(z.string().min(1).max(120)).max(200).default([]),
    dislikes: z.array(z.string().min(1).max(120)).max(100).default([]),
    dietary: z.array(z.string().min(1).max(120)).max(20).default([]),
    /**
     * Appliances the user actually owns. Asked once at onboarding, then
     * treated exactly like the pantry: evidence the recipe is grounded
     * against. No air fryer, no air fryer recipes.
     */
    cookware: z.array(EquipmentSchema).max(40).default([]),
  })
  .strict();
export type CookRequest = z.infer<typeof CookRequestSchema>;

/**
 * The verifier's output. Every violation is computed deterministically in code
 * — never by asking a model "did you follow the rules?", which is the mistake
 * that makes most AI recipe apps confidently wrong.
 */
export const ViolationSchema = z
  .object({
    kind: z.enum([
      "missing_ingredient", // needs shopping when willShop === false
      "missing_equipment", // a step needs an appliance the user doesn't own
      "over_time", // prep + cook exceeds maxMinutes
      "step_time_mismatch", // step minutes don't sum to the stated total
      "disliked_ingredient", // contains something on the dislike list
      "dietary_conflict", // contains something the dietary tags forbid
      "servings_mismatch",
    ]),
    detail: z.string(),
    /** Which ingredient/step triggered it, when applicable. */
    subject: z.string().nullable(),
  })
  .strict();
export type Violation = z.infer<typeof ViolationSchema>;

export const VerificationSchema = z
  .object({
    ok: z.boolean(),
    violations: z.array(ViolationSchema),
    /** Recomputed by us, not taken from the model. */
    shoppingList: z.array(z.string()),
    pantryUsedCount: z.number(),
    totalMinutes: z.number(),
    /**
     * Derived from the steps rather than asked of the model — arithmetic we
     * can do exactly is arithmetic we should never delegate.
     * "40 minutes, 8 of them hands-on" is the number people actually decide on.
     */
    activeMinutes: z.number(),
    passiveMinutes: z.number(),
    /** Appliances used that the user does own — shown as reassurance. */
    equipmentUsed: z.array(z.string()),
    /**
     * Ingredients the verifier could not confidently classify — not in the
     * taxonomy, so no dietary attributes are known for them.
     *
     * A third state exists because the checker used to have only confident
     * answers, and that is exactly how it came to insist that coconut milk was
     * dairy. For a product whose whole claim is "the badge can be trusted", a
     * confident wrong answer costs far more than an admitted gap — so anything
     * unknown is surfaced as a question rather than asserted as a violation.
     */
    uncertain: z.array(z.string()),
  })
  .strict();
export type Verification = z.infer<typeof VerificationSchema>;
