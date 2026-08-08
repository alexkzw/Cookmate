import { z } from "zod";

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
    /** Free-text pantry lines, one item per entry. */
    pantry: z.array(z.string().min(1).max(80)).max(200).default([]),
    dislikes: z.array(z.string().min(1).max(80)).max(100).default([]),
    dietary: z.array(z.string().min(1).max(80)).max(20).default([]),
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
  })
  .strict();
export type Verification = z.infer<typeof VerificationSchema>;
