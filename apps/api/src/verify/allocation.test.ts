import { describe, it, expect } from "vitest";
import type { MealPlanAllocation } from "@cookmate/shared";
import { verifyAllocation, __testables } from "./allocation.js";

/**
 * The allocation verifier's job is to catch the failures that are INVISIBLE to
 * per-recipe checking: three recipes that are each individually legal but
 * jointly impossible. Every test here is a case `verifyRecipe` would happily
 * pass three times over.
 */

const { isExclusive, resolveClaim } = __testables;

/** A pantry with three proteins — enough that every day can have its own. */
const RICH_PANTRY = [
  "chicken thighs",
  "salmon fillet",
  "beef mince",
  "onion",
  "garlic",
  "rice",
  "soy sauce",
  "carrot",
];

function plan(meals: MealPlanAllocation["meals"]): MealPlanAllocation {
  return { feasible: true, infeasibleReason: null, meals, leftovers: [] };
}

function meal(day: number, claimedPantry: string[], concept = `day ${day} dinner`) {
  return { day, concept, cuisine: "fusion", craving: `make ${concept}`, claimedPantry };
}

describe("isExclusive", () => {
  it("treats proteins as scarce", () => {
    expect(isExclusive("chicken thighs")).toBe(true);
    expect(isExclusive("salmon fillet")).toBe(true);
    expect(isExclusive("beef mince")).toBe(true);
  });

  it("treats aromatics and grains as shareable", () => {
    expect(isExclusive("onion")).toBe(false);
    expect(isExclusive("rice")).toBe(false);
    expect(isExclusive("soy sauce")).toBe(false);
  });

  /**
   * REGRESSION: the taxonomy flags these as meat/fish for DIETARY purposes, and
   * the first version of this rule read that flag directly — which would have
   * rationed fish sauce across three Thai dinners and reported a double
   * allocation on the most ordinary plan imaginable.
   *
   * Dietary attributes answer "may a vegetarian eat this"; scarcity answers
   * "does this run out". Same flag, different questions.
   */
  it("does not ration stocks and condiments that merely carry a meat/fish flag", () => {
    expect(isExclusive("fish sauce")).toBe(false);
    expect(isExclusive("oyster sauce")).toBe(false);
    expect(isExclusive("worcestershire sauce")).toBe(false);
    expect(isExclusive("chicken stock")).toBe(false);
  });

  it("treats unknown items as shareable rather than guessing", () => {
    expect(isExclusive("some artisanal thing")).toBe(false);
  });
});

describe("resolveClaim", () => {
  it("matches plurals and synonyms through the taxonomy", () => {
    expect(resolveClaim("chicken thigh", RICH_PANTRY)).toBe("chicken thighs");
    expect(resolveClaim("onions", RICH_PANTRY)).toBe("onion");
  });

  it("returns null for something genuinely absent", () => {
    expect(resolveClaim("saffron", RICH_PANTRY)).toBeNull();
  });
});

describe("verifyAllocation", () => {
  it("passes a plan where every meal has its own protein", () => {
    const result = verifyAllocation(
      plan([
        meal(1, ["chicken thighs", "onion", "rice"]),
        meal(2, ["salmon fillet", "garlic", "rice"]),
        meal(3, ["beef mince", "onion", "carrot"]),
      ]),
      RICH_PANTRY,
      3,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.mealsPlanned).toBe(3);
  });

  /**
   * THE HEADLINE CASE. Each of these three meals is individually legal — the
   * chicken really is in the pantry — and `verifyRecipe` would pass all three.
   * Only a joint check sees that there is one packet of chicken and two dinners
   * planned around it.
   */
  it("catches an exclusive item claimed by two meals", () => {
    const result = verifyAllocation(
      plan([
        meal(1, ["chicken thighs", "rice"]),
        meal(2, ["chicken thighs", "onion"]),
        meal(3, ["beef mince", "carrot"]),
      ]),
      RICH_PANTRY,
      3,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain("double_allocated");
    expect(result.violations.find((v) => v.kind === "double_allocated")?.subject).toBe(
      "chicken thighs",
    );
  });

  it("allows shared aromatics across every meal", () => {
    const result = verifyAllocation(
      plan([
        meal(1, ["chicken thighs", "onion", "garlic", "soy sauce"]),
        meal(2, ["salmon fillet", "onion", "garlic", "soy sauce"]),
        meal(3, ["beef mince", "onion", "garlic", "soy sauce"]),
      ]),
      RICH_PANTRY,
      3,
    );
    expect(result.ok).toBe(true);
  });

  /**
   * The hallucination check. A planner that invents an ingredient produces a
   * recipe built on something the user does not own — the single most damaging
   * thing this feature could do, because it breaks the app's core promise while
   * looking completely normal on the card.
   */
  it("catches a claim on something not in the pantry", () => {
    const result = verifyAllocation(
      plan([
        meal(1, ["chicken thighs", "saffron"]),
        meal(2, ["salmon fillet"]),
        meal(3, ["beef mince"]),
      ]),
      RICH_PANTRY,
      3,
    );
    expect(result.ok).toBe(false);
    const phantom = result.violations.find((v) => v.kind === "phantom_ingredient");
    expect(phantom?.subject).toBe("saffron");
  });

  it("catches a meal left with nothing substantial when there was enough to go round", () => {
    const result = verifyAllocation(
      plan([
        meal(1, ["chicken thighs", "salmon fillet"]),
        meal(2, ["beef mince"]),
        meal(3, ["onion", "rice"]),
      ]),
      RICH_PANTRY,
      3,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain("empty_meal");
  });

  /**
   * ...but a meatless day is legitimate when the pantry genuinely cannot give
   * every day a protein. Enforcing `empty_meal` unconditionally would make every
   * vegetarian plan illegal — the check must only fire where the planner
   * actually had a choice.
   */
  it("allows a meatless day when there were not enough proteins to allocate", () => {
    const thinPantry = ["chicken thighs", "onion", "garlic", "rice", "lentils", "carrot"];
    const result = verifyAllocation(
      plan([
        meal(1, ["chicken thighs", "rice"]),
        meal(2, ["lentils", "carrot"]),
        meal(3, ["onion", "garlic", "rice"]),
      ]),
      thinPantry,
      3,
    );
    expect(result.ok).toBe(true);
  });

  it("catches the wrong number of meals", () => {
    const result = verifyAllocation(
      plan([meal(1, ["chicken thighs"]), meal(2, ["salmon fillet"])]),
      RICH_PANTRY,
      3,
    );
    expect(result.violations.map((v) => v.kind)).toContain("malformed_plan");
  });

  it("catches a duplicated day number", () => {
    const result = verifyAllocation(
      plan([
        meal(1, ["chicken thighs"]),
        meal(1, ["salmon fillet"]),
        meal(3, ["beef mince"]),
      ]),
      RICH_PANTRY,
      3,
    );
    expect(result.violations.map((v) => v.kind)).toContain("malformed_plan");
  });

  /**
   * AN HONEST REFUSAL IS A PASS.
   *
   * This is the case the adversarial eval fixtures are built around: a pantry
   * that genuinely cannot stretch to three dinners. Saying so is correct
   * behaviour, so `ok` must be true — if a refusal scored as a verifier failure,
   * the eval could not tell "refused correctly" from "broke".
   */
  it("treats a well-formed refusal as valid", () => {
    const result = verifyAllocation(
      {
        feasible: false,
        infeasibleReason: "Only enough for one dinner — there is no second protein.",
        meals: [],
        leftovers: ["onion"],
      },
      ["onion", "rice"],
      3,
    );
    expect(result.ok).toBe(true);
    expect(result.mealsPlanned).toBe(0);
  });

  it("catches a refusal that still planned meals", () => {
    const result = verifyAllocation(
      {
        feasible: false,
        infeasibleReason: "not enough",
        meals: [meal(1, ["chicken thighs"])],
        leftovers: [],
      },
      RICH_PANTRY,
      3,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain("inconsistent_feasibility");
  });

  /**
   * Leftovers are recomputed rather than believed — the planner's own
   * `leftovers` field is decorative, exactly like the model's `source` claim on
   * an ingredient.
   */
  it("recomputes leftovers rather than trusting the planner's list", () => {
    const allocation: MealPlanAllocation = {
      feasible: true,
      infeasibleReason: null,
      meals: [
        meal(1, ["chicken thighs", "rice"]),
        meal(2, ["salmon fillet"]),
        meal(3, ["beef mince"]),
      ],
      // A lie: claims nothing is left over, when four items are untouched.
      leftovers: [],
    };
    const result = verifyAllocation(allocation, RICH_PANTRY, 3);
    expect(result.unclaimedPantry).toContain("onion");
    expect(result.unclaimedPantry).toContain("soy sauce");
    expect(result.unclaimedPantry).not.toContain("chicken thighs");
  });
});
