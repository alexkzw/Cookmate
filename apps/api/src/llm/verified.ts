import type { CookRequest, Recipe, Verification } from "@cookmate/shared";
import { verifyRecipe } from "../verify/constraints.js";
import { streamRecipe, RecipeGenerationError } from "./generate.js";
import { buildRepairTurn } from "./repair.js";
import type { CallUsage } from "./models.js";
import type { ConversationTurn } from "../telemetry/turns.js";

/**
 * GENERATE, VERIFY, AND REPAIR ONCE.
 *
 * Until now the verifier was a REPORTER: it detected violations and showed them
 * to the user, and a failing recipe was still the recipe you got. This makes it
 * a CONTROLLER — the verdict becomes control flow.
 *
 * Bounded at a single retry, deliberately:
 *
 *   - Each attempt costs real money and ~25 seconds of someone's evening.
 *   - If a precise, itemised description of the defect doesn't fix it on the
 *     second try, a third is unlikely to help. Unbounded repair loops are how
 *     an agent quietly spends $40 on one request.
 *
 * When repair fails, the BETTER of the two attempts is returned — fewer
 * violations wins — and the user still sees an honest verdict. Repair improves
 * the odds; it never suppresses the result.
 */

export interface VerifiedGeneration {
  recipe: Recipe;
  verification: Verification;
  /** Summed across attempts: what the whole turn actually cost. */
  usage: CallUsage;
  attempts: number;
  /**
   * How many times a generation had to be thrown away and resampled because the
   * output wasn't a Recipe at all. Should be 0 essentially always — structured
   * outputs are supposed to make it impossible — which is exactly why it is
   * counted rather than swallowed. A number that is meant to stay zero is only
   * useful if something would notice it moving.
   */
  resamples: number;
  /** Did the FIRST attempt pass? The number a repair loop is judged on. */
  firstPassOk: boolean;
  /** Violation kinds from the first attempt, even if repair later fixed them. */
  firstPassKinds: string[];
  /**
   * The first attempt's FULL verdict. `verification` above is the final one,
   * which after a successful repair is a pass — so this is the only place the
   * defect that triggered the repair survives. Kinds alone tell you the model
   * got the arithmetic wrong; the detail tells you it claimed 28 minutes over
   * steps totalling 41, which is the difference between knowing a category and
   * being able to fix it.
   */
  firstPassVerification: Verification;
}

/** Sum two calls into one turn-level total. Rates differ per model, so costs add. */
function combine(a: CallUsage, b: CallUsage): CallUsage {
  return {
    model: a.model,
    effort: a.effort,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    // The repair attempt's cache behaviour is the interesting one: the system
    // prompt is unchanged, so it should READ the prefix the first attempt wrote.
    cacheStatus: b.cacheStatus,
    costUsd: a.costUsd + b.costUsd,
    latencyMs: a.latencyMs + b.latencyMs,
  };
}

/**
 * OUTPUT-SHAPE FAILURES THAT ARE WORTH RESAMPLING.
 *
 * There are two completely different ways a generation can be unusable, and
 * they need completely different responses:
 *
 *   MALFORMED  — the output isn't a Recipe at all. Unparseable, empty, wrong
 *                shape. There is nothing to critique, so feeding it back would
 *                just be asking the model to look at rubbish. The right move is
 *                to SAMPLE AGAIN: same prompt, new roll of the dice.
 *
 *   WRONG      — the output is a perfectly valid Recipe that breaks a rule.
 *                Resampling would be throwing away information: we know exactly
 *                what is wrong and can say so. The right move is to REPAIR.
 *
 * Cookmate had the second and not the first, which is backwards from what you
 * would guess — it retried the expensive, hard, semantic failure and gave up on
 * the cheap, mechanical one. This closes that asymmetry.
 *
 * `truncated` and `refusal` are deliberately NOT here. A refusal repeats: the
 * same request will be declined again, and paying for a second guaranteed
 * refusal is worse than telling the user now. A truncation would only clear if
 * the request were SIMPLIFIED, and we do not simplify it — so resampling one
 * unchanged is a coin flip we are paying for. Retry only where the retry has a
 * reason to work.
 */
const RESAMPLE_CODES = new Set(["schema_mismatch", "empty_response"]);

/**
 * Generate once, resampling at most once if the output was malformed.
 *
 * Bounded at a single resample for the same reason the repair loop is: the
 * second sample is real money and ~25 seconds, and if structured outputs have
 * failed twice in a row the problem is the schema or the provider, not luck —
 * neither of which a third sample fixes.
 *
 * NOT SILENT, on purpose. Deltas from the failed attempt already reached the
 * browser, so `onResample` fires and the client resets its preview. A hidden
 * retry would leave a half-scraped title from a discarded generation sitting on
 * screen, and would also hide the exact event that most needs to be visible:
 * a `schema_mismatch` is CRITICAL severity precisely because structured outputs
 * are supposed to make it impossible.
 */
async function generateWithResample(
  request: CookRequest,
  onTextDelta: (text: string) => void,
  signal: AbortSignal | undefined,
  options: { userTurnOverride?: string; history: ConversationTurn[] },
  onResample?: (reason: string) => void,
): Promise<{ result: Awaited<ReturnType<typeof streamRecipe>>; resamples: number }> {
  try {
    return { result: await streamRecipe(request, onTextDelta, signal, options), resamples: 0 };
  } catch (err) {
    if (!(err instanceof RecipeGenerationError) || !RESAMPLE_CODES.has(err.code)) throw err;

    onResample?.(err.code);
    // If this one throws too, it propagates: the caller sees the SECOND
    // failure, which is the more informative one. The first attempt's usage is
    // lost from the turn record, and that is a known, accepted gap — the
    // alternative is threading a partial-usage object through a throw path,
    // which costs more clarity than the ~$0.02 it accounts for.
    const result = await streamRecipe(request, onTextDelta, signal, options);
    return { result, resamples: 1 };
  }
}

export async function generateVerifiedRecipe(
  request: CookRequest,
  onTextDelta: (text: string) => void,
  options: {
    repair?: boolean;
    signal?: AbortSignal;
    onRepairStart?: (issues: string[]) => void;
    /**
     * The model returned something that wasn't a Recipe and we're sampling
     * again. The browser has already been shown deltas from the discarded
     * attempt, so it needs to know to clear them.
     */
    onResample?: (reason: string) => void;
    /**
     * Prior turns, oldest first. Passed straight through to both attempts —
     * a repair must see the same conversation the first attempt saw, or it is
     * answering a different question.
     */
    history?: ConversationTurn[];
  } = {},
): Promise<VerifiedGeneration> {
  const history = options.history ?? [];
  const { result: first, resamples: firstResamples } = await generateWithResample(
    request,
    onTextDelta,
    options.signal,
    { history },
    options.onResample,
  );
  const firstVerification = verifyRecipe(first.recipe, request);
  const firstPassKinds = [...new Set(firstVerification.violations.map((v) => v.kind))].sort();

  const shouldRepair = options.repair !== false && !firstVerification.ok;
  if (!shouldRepair) {
    return {
      recipe: first.recipe,
      verification: firstVerification,
      usage: first.usage,
      attempts: 1,
      resamples: firstResamples,
      firstPassOk: firstVerification.ok,
      firstPassKinds,
      firstPassVerification: firstVerification,
    };
  }

  options.onRepairStart?.(firstVerification.violations.map((v) => v.detail));

  const repairPrompt = buildRepairTurn(request, first.recipe, firstVerification);
  const { result: second, resamples: secondResamples } = await generateWithResample(
    request,
    onTextDelta,
    options.signal,
    { userTurnOverride: repairPrompt, history },
    options.onResample,
  );
  const secondVerification = verifyRecipe(second.recipe, request);
  const usage = combine(first.usage, second.usage);

  // Keep whichever attempt is actually better. A repair that introduces new
  // violations must not be allowed to make the answer worse than what we had.
  const repairHelped =
    secondVerification.violations.length < firstVerification.violations.length;

  return {
    recipe: repairHelped ? second.recipe : first.recipe,
    verification: repairHelped ? secondVerification : firstVerification,
    usage,
    attempts: 2,
    resamples: firstResamples + secondResamples,
    firstPassOk: false,
    firstPassKinds,
    firstPassVerification: firstVerification,
  };
}
