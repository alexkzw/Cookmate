import type { CookRequest, Recipe, Verification } from "@cookmate/shared";
import { buildUserTurn } from "./prompts.js";

/**
 * THE REPAIR PROMPT.
 *
 * The verifier already knows exactly what is wrong and can say it precisely —
 * "steps add up to 47 minutes but the recipe claims 45". That is a far better
 * correction signal than "try again", because it names the defect rather than
 * asking the model to re-discover it.
 *
 * Two deliberate choices:
 *
 * 1. THIS GOES IN THE USER TURN, after the cache breakpoint. The system prompt
 *    stays byte-identical, so a repair attempt reads the cached prefix instead
 *    of writing a new one — the retry is materially cheaper than a cold call.
 *
 * 2. THE PREVIOUS RECIPE IS INCLUDED. Most violations are arithmetic about the
 *    model's own output; without seeing its previous step times it cannot fix
 *    them, only reroll and hope. Reroll is not repair.
 */
export function buildRepairTurn(
  request: CookRequest,
  previous: Recipe,
  verification: Verification,
): string {
  const problems = verification.violations
    .map((v, i) => `${i + 1}. [${v.kind}] ${v.detail}`)
    .join("\n");

  return [
    buildUserTurn(request),
    "",
    "---",
    "",
    "You already answered this, and an automated checker found problems with it.",
    "This is not a request for a different dish — keep the same recipe and fix",
    "only what is listed, unless a problem makes the dish impossible.",
    "",
    "Problems found:",
    problems,
    "",
    "Your previous answer:",
    JSON.stringify(previous),
    "",
    "Return a corrected recipe in the same format. Fix only what was flagged —",
    "changing things that already passed risks trading one violation for another.",
  ].join("\n");
}
