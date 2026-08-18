import type { CookRequest, Recipe, Verification } from "@cookmate/shared";
import { verifyRecipe } from "../verify/constraints.js";
import { streamRecipe } from "./generate.js";
import { buildRepairTurn } from "./repair.js";
import type { CallUsage } from "./models.js";

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

export async function generateVerifiedRecipe(
  request: CookRequest,
  onTextDelta: (text: string) => void,
  options: {
    repair?: boolean;
    signal?: AbortSignal;
    onRepairStart?: (issues: string[]) => void;
  } = {},
): Promise<VerifiedGeneration> {
  const first = await streamRecipe(request, onTextDelta, options.signal);
  const firstVerification = verifyRecipe(first.recipe, request);
  const firstPassKinds = [...new Set(firstVerification.violations.map((v) => v.kind))].sort();

  const shouldRepair = options.repair !== false && !firstVerification.ok;
  if (!shouldRepair) {
    return {
      recipe: first.recipe,
      verification: firstVerification,
      usage: first.usage,
      attempts: 1,
      firstPassOk: firstVerification.ok,
      firstPassKinds,
      firstPassVerification: firstVerification,
    };
  }

  options.onRepairStart?.(firstVerification.violations.map((v) => v.detail));

  const repairPrompt = buildRepairTurn(request, first.recipe, firstVerification);
  const second = await streamRecipe(request, onTextDelta, options.signal, repairPrompt);
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
    firstPassOk: false,
    firstPassKinds,
    firstPassVerification: firstVerification,
  };
}
