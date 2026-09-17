import type {
  AllocationVerification,
  AllocationViolation,
  MealPlanAllocation,
} from "@cookmate/shared";
import { lemmaKey, lookup } from "./resolve.js";

/**
 * THE ALLOCATION VERIFIER.
 *
 * `verifyRecipe` asks "is this recipe legal against this pantry?". This asks the
 * harder question: "are these N recipes JOINTLY legal against ONE pantry?" —
 * which no amount of per-recipe checking can answer, because three individually
 * legal recipes can all have planned around the same single piece of chicken.
 *
 * Like every other check in this codebase it is plain TypeScript with no model
 * call. Allocation is set arithmetic: which items exist, which meal claimed
 * them, was anything claimed twice. Those are decidable, so they are decided
 * here rather than asked of the system that produced the claim.
 *
 * It runs BEFORE any recipe is generated, which is the entire economic argument
 * for the plan-then-generate design. A rejected plan costs a few hundred planner
 * tokens; a rejected set of three finished recipes costs ~$0.14 and 80 seconds.
 */

/**
 * WHAT COUNTS AS SCARCE.
 *
 * A meal plan is only an interesting constraint problem because some things run
 * out. But the app has no quantities — CLAUDE.md rules them out deliberately
 * ("UI friction outweighs the gain") — so "how much chicken" is not a question
 * this system can answer.
 *
 * Rather than guess at quantities, the rule keys off the attribute the taxonomy
 * already carries, and off the real culinary shape of the problem:
 *
 *   MEAT AND FISH ARE EXCLUSIVE. They are the centrepiece, they are bought per
 *   meal, and they are what actually runs out. "Three dinners from one pantry"
 *   is hard precisely because there is one packet of chicken thighs.
 *
 *   EVERYTHING ELSE IS SHAREABLE. Nobody buys three onions for three meals and
 *   nobody is surprised when soy sauce appears twice. Rationing aromatics would
 *   produce false violations on the most normal possible plan.
 *
 * Anything the taxonomy does not recognise is treated as SHAREABLE, which is the
 * conservative direction: an unknown item produces no violation rather than a
 * confident wrong one. Same instinct as `uncertain` in the recipe verifier —
 * where this checker cannot justify a claim, it declines to make one.
 *
 * This judgement is REPORTED on the verification, not just applied, because it
 * is the one a user might reasonably dispute.
 */

/**
 * Meat/fish by attribute, but NOT scarce — the condiments and stocks.
 *
 * The taxonomy's `meat` and `fish` flags answer a DIETARY question ("may a
 * vegetarian eat this?"), and fish sauce, oyster sauce, Worcestershire and
 * chicken stock all correctly carry them. Scarcity is a different question, and
 * reusing the dietary answer for it without adjustment gets exactly these wrong:
 * a bottle of fish sauce appears in all three Thai dinners and nobody is
 * rationing it.
 *
 * Two questions, two answers, one attribute — so the attribute needs a
 * qualifier rather than a second flag on 200 taxonomy entries. This is the same
 * shape as `name` vs `matchTerm`: one field cannot serve two jobs, and the fix
 * is to be explicit about which job is being done.
 */
const NOT_SCARCE_IDS = new Set([
  "chicken_stock",
  "beef_stock",
  "fish_stock",
  "fish_sauce",
  "oyster_sauce",
  "worcestershire",
  // A tin of anchovies is a store-cupboard item that garnishes three dishes,
  // not a centrepiece anyone plans a dinner around.
  "anchovy",
]);

function isExclusive(pantryEntry: string): boolean {
  const entry = lookup(pantryEntry);
  if (!entry) return false;
  if (NOT_SCARCE_IDS.has(entry.id)) return false;
  return entry.attrs.meat === true || entry.attrs.fish === true;
}

/**
 * Match a planner claim back to a real pantry line.
 *
 * The planner is told to copy pantry entries verbatim, and mostly does — but
 * "chicken thighs" against a pantry line of "chicken thigh" must not read as a
 * hallucinated ingredient. Canonical id first (immune to plurals and synonyms),
 * then lemma equality for anything outside the taxonomy.
 *
 * Deliberately NOT fuzzy beyond that. A loose substring match here would let
 * "chicken stock" resolve against a pantry holding only "chicken" — the exact
 * false positive the recipe verifier's head-noun guard exists to prevent — and
 * the cost of being wrong is high: a phantom claim silently becomes a real
 * recipe built on an ingredient the user does not own.
 */
function resolveClaim(claim: string, pantry: string[]): string | null {
  const claimEntry = lookup(claim);
  const claimKey = lemmaKey(claim);

  for (const item of pantry) {
    if (claimEntry) {
      const itemEntry = lookup(item);
      if (itemEntry && itemEntry.id === claimEntry.id) return item;
    }
    if (lemmaKey(item) === claimKey) return item;
  }
  return null;
}

export function verifyAllocation(
  allocation: MealPlanAllocation,
  pantry: string[],
  expectedDays: number,
): AllocationVerification {
  const violations: AllocationViolation[] = [];

  /**
   * FEASIBILITY CONSISTENCY, checked first.
   *
   * The planner has two ways to be incoherent about its own verdict, and both
   * matter. Claiming feasible while planning nothing produces an empty plan the
   * UI would render as success; claiming infeasible while planning three meals
   * means the refusal is decorative and the meals would be cooked anyway.
   */
  if (!allocation.feasible) {
    if (allocation.meals.length > 0) {
      violations.push({
        kind: "inconsistent_feasibility",
        detail: `Declared the pantry infeasible but still planned ${allocation.meals.length} meal(s).`,
        subject: null,
      });
    }
    // An honest refusal is a VALID allocation. `ok` stays true so the caller can
    // distinguish "the planner is broken" from "the planner correctly said no" —
    // conflating those would make the adversarial eval fixtures unscoreable.
    return {
      ok: violations.length === 0,
      violations,
      exclusiveItems: pantry.filter(isExclusive),
      sharedItems: pantry.filter((p) => !isExclusive(p)),
      unclaimedPantry: [...pantry],
      mealsPlanned: 0,
    };
  }

  if (allocation.meals.length !== expectedDays) {
    violations.push({
      kind: "malformed_plan",
      detail: `Planned ${allocation.meals.length} meals but ${expectedDays} were requested.`,
      subject: null,
    });
  }

  const seenDays = new Set<number>();
  for (const meal of allocation.meals) {
    if (seenDays.has(meal.day)) {
      violations.push({
        kind: "malformed_plan",
        detail: `Day ${meal.day} appears more than once.`,
        subject: String(meal.day),
      });
    }
    seenDays.add(meal.day);
  }

  /**
   * THE CORE CHECK: who claimed what.
   *
   * One pass over every claim in every meal, resolving each against the real
   * pantry and recording which meals claimed it. Everything below reads off
   * this map — double-allocation is a key with two meals against an exclusive
   * item, phantom ingredients are claims that resolved to nothing.
   */
  const claimsByItem = new Map<string, number[]>();
  const substantiveByDay = new Map<number, number>();

  for (const meal of allocation.meals) {
    let substantive = 0;

    for (const claim of meal.claimedPantry) {
      const resolved = resolveClaim(claim, pantry);

      if (resolved === null) {
        violations.push({
          kind: "phantom_ingredient",
          detail: `Day ${meal.day} claims "${claim}", which is not in the pantry.`,
          subject: claim,
        });
        continue;
      }

      const claimants = claimsByItem.get(resolved) ?? [];
      if (!claimants.includes(meal.day)) claimants.push(meal.day);
      claimsByItem.set(resolved, claimants);

      // A meal is "substantive" if it has something of its own worth building
      // around. Shared aromatics do not make a meal; the exclusive item does.
      if (isExclusive(resolved)) substantive += 1;
    }

    substantiveByDay.set(meal.day, substantive);
  }

  for (const [item, claimants] of claimsByItem) {
    if (claimants.length > 1 && isExclusive(item)) {
      violations.push({
        kind: "double_allocated",
        detail: `"${item}" is claimed by days ${claimants.join(" and ")}, but there is only one of it.`,
        subject: item,
      });
    }
  }

  /**
   * EMPTY MEALS.
   *
   * A plan that gives day three nothing but onion and soy sauce has not solved
   * the problem, it has deferred it — the recipe generator would then be asked
   * to build a dinner out of aromatics and would either produce something
   * miserable or quietly reach for an ingredient nobody has.
   *
   * Only enforced when the pantry actually contains enough exclusive items to go
   * around. With one packet of chicken and three days, SOMETHING has to be
   * meatless, and calling that a violation would make every vegetarian plan
   * illegal. The check fires only where the planner had a real choice.
   */
  const exclusiveCount = pantry.filter(isExclusive).length;
  if (exclusiveCount >= allocation.meals.length) {
    for (const meal of allocation.meals) {
      if ((substantiveByDay.get(meal.day) ?? 0) === 0) {
        violations.push({
          kind: "empty_meal",
          detail: `Day ${meal.day} has no substantial ingredient of its own, though the pantry has ${exclusiveCount} to allocate.`,
          subject: meal.concept,
        });
      }
    }
  }

  /**
   * Leftovers are RECOMPUTED, never read from `allocation.leftovers`.
   *
   * Same rule as the recipe verifier recomputing `source`: the model's account
   * of what it did is a claim, and this is the one place that can check it. The
   * planner's own `leftovers` field is left in the schema because writing it
   * makes the model reason about what it did not use — but it is never trusted.
   */
  const unclaimedPantry = pantry.filter((item) => !claimsByItem.has(item));

  return {
    ok: violations.length === 0,
    violations,
    exclusiveItems: pantry.filter(isExclusive),
    sharedItems: pantry.filter((p) => !isExclusive(p)),
    unclaimedPantry,
    mealsPlanned: allocation.meals.length,
  };
}

/**
 * The pantry ONE meal is allowed to cook from.
 *
 * This is what turns a verified allocation into an enforced one. Each meal is
 * generated against a narrowed pantry rather than the real one:
 *
 *   exclusive items — ONLY the ones this meal claimed. The chicken genuinely is
 *                     not available to day two, so day two must not see it.
 *   shared items    — ALL of them. The onion was never rationed, and hiding it
 *                     would force the recipe writer to shop for something the
 *                     user is standing next to.
 *
 * The narrowing is what makes the rationing real rather than advisory. With
 * `willShop: false` — the default for a plan — anything outside this list that
 * the recipe reaches for is recomputed as `shopping` by the recipe verifier and
 * becomes a `missing_ingredient` violation, which the existing repair loop then
 * has to fix.
 *
 * So the allocation is enforced TWICE, by two independent checkers: once before
 * generation by `verifyAllocation`, and again per-recipe by `verifyRecipe`
 * without either knowing about the other. The second is not redundant — it is
 * what catches a recipe that drifts off its own brief.
 */
export function pantryForMeal(claimedPantry: string[], fullPantry: string[]): string[] {
  const claimed = new Set<string>();
  for (const claim of claimedPantry) {
    const resolved = resolveClaim(claim, fullPantry);
    if (resolved !== null) claimed.add(resolved);
  }
  return fullPantry.filter((item) => !isExclusive(item) || claimed.has(item));
}

/** Exported for unit tests. */
export const __testables = { isExclusive, resolveClaim };
