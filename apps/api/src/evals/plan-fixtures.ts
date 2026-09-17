import { createHash } from "node:crypto";
import type { Equipment, MealPlanRequest } from "@cookmate/shared";

/**
 * THE MEAL-PLAN EVAL SET.
 *
 * The single-recipe fixture set has one rule: every case is satisfiable, so a
 * failure is unambiguously a defect rather than an unfair question. This set
 * deliberately BREAKS that rule, because the meal planner has a second correct
 * behaviour that the recipe generator does not have — it can say no.
 *
 * So fixtures come in two kinds, and the distinction is the whole point:
 *
 *   FEASIBLE    — the pantry genuinely supports N distinct dinners. A correct
 *                 system produces a plan that passes the allocation verifier.
 *
 *   ADVERSARIAL — the pantry genuinely does NOT. A correct system says so.
 *                 The failure mode being probed is the one that would do real
 *                 damage: inventing a third dinner out of ingredients the user
 *                 does not own, which looks completely normal on the card and
 *                 is only discovered at the stove.
 *
 * Without the adversarial half, "did it produce three meals?" is a metric a
 * hallucinating planner scores 100% on. That is the reason this half exists:
 * the interesting question is not whether the model can fill three slots, it is
 * whether it will refuse to when the pantry cannot pay for them.
 *
 * `expectFeasible` is what makes a refusal scoreable. On an adversarial fixture
 * a refusal is a PASS and a plan is a FAIL — the exact inversion of the other
 * half — so the suite cannot be gamed by a model that always plans or one that
 * always refuses.
 */

export interface PlanFixture {
  id: string;
  /** Which behaviour this case is aimed at. */
  probes: string;
  /** The pantry the plan must be built from. */
  pantry: string[];
  dislikes: string[];
  dietary: string[];
  cookware: Equipment[];
  request: MealPlanRequest;
  /**
   * What a correct system should decide.
   *
   * true  — a plan is expected, and it must pass `verifyAllocation`.
   * false — a refusal is expected. Producing a plan anyway is the failure.
   */
  expectFeasible: boolean;
}

const base = {
  days: 3,
  servings: 2,
  maxMinutes: 40,
  effort: "moderate" as const,
  // False throughout: a plan whose planner may shop is not solving the
  // allocation problem, it is avoiding it — and every adversarial fixture would
  // become trivially feasible.
  willShop: false,
  note: "",
};

const KITCHEN: Equipment[] = ["oven", "stovetop", "microwave"];

export const PLAN_FIXTURES: PlanFixture[] = [
  /* ── FEASIBLE ─────────────────────────────────────────────────────────── */
  {
    id: "three-proteins-easy",
    probes: "baseline — one protein per day, nothing binding",
    expectFeasible: true,
    pantry: [
      "chicken thighs", "salmon fillet", "beef mince",
      "onion", "garlic", "ginger", "rice", "pasta",
      "soy sauce", "tinned tomatoes", "carrot", "spinach",
    ],
    dislikes: [],
    dietary: [],
    cookware: KITCHEN,
    request: { ...base },
  },
  {
    id: "two-proteins-one-veg-day",
    probes: "a legitimately meatless day — must NOT be scored as an empty meal",
    expectFeasible: true,
    pantry: [
      "chicken thighs", "salmon fillet",
      "lentils", "chickpeas", "onion", "garlic", "rice",
      "tinned tomatoes", "spinach", "carrot", "cumin", "yoghurt",
    ],
    dislikes: [],
    dietary: [],
    cookware: KITCHEN,
    request: { ...base },
  },
  {
    id: "vegetarian-three-days",
    probes: "no meat at all — scarcity rule must not demand a protein per day",
    expectFeasible: true,
    pantry: [
      "tofu", "lentils", "chickpeas", "paneer",
      "onion", "garlic", "rice", "pasta", "tinned tomatoes",
      "spinach", "mushroom", "courgette", "cumin", "paprika",
    ],
    dislikes: [],
    dietary: ["vegetarian"],
    cookware: KITCHEN,
    request: { ...base },
  },
  {
    id: "shared-condiment-trap",
    probes: "fish sauce and chicken stock across every meal — must not read as double-allocation",
    expectFeasible: true,
    pantry: [
      "chicken thighs", "prawns", "pork mince",
      "fish sauce", "oyster sauce", "chicken stock",
      "rice noodles", "rice", "onion", "garlic", "ginger", "chilli", "lime",
    ],
    dislikes: [],
    dietary: [],
    cookware: KITCHEN,
    request: { ...base },
  },
  {
    id: "two-days-only",
    probes: "a shorter plan — the day count is a parameter, not a constant",
    expectFeasible: true,
    pantry: [
      "chicken thighs", "salmon fillet", "onion", "garlic",
      "rice", "lemon", "butter", "spinach", "potato",
    ],
    dislikes: [],
    dietary: [],
    cookware: KITCHEN,
    request: { ...base, days: 2 },
  },

  /* ── ADVERSARIAL — a refusal is the correct answer ────────────────────── */
  {
    id: "one-protein-three-days",
    probes: "THE headline adversarial case — one protein cannot anchor three dinners",
    expectFeasible: false,
    pantry: ["chicken breast", "onion", "salt", "rice"],
    dislikes: [],
    dietary: [],
    cookware: KITCHEN,
    request: { ...base },
  },
  {
    id: "aromatics-only",
    probes: "nothing substantial at all — flavourings are not dinner",
    expectFeasible: false,
    pantry: ["garlic", "ginger", "soy sauce", "chilli flakes", "olive oil", "oregano"],
    dislikes: [],
    dietary: [],
    cookware: KITCHEN,
    request: { ...base },
  },
  {
    id: "empty-pantry",
    probes: "degenerate case — must refuse rather than invent an entire pantry",
    expectFeasible: false,
    pantry: [],
    dislikes: [],
    dietary: [],
    cookware: KITCHEN,
    request: { ...base },
  },
  {
    id: "dietary-eliminates-the-pantry",
    probes: "enough food, but the dietary rule removes almost all of it",
    expectFeasible: false,
    pantry: ["chicken thighs", "beef mince", "bacon", "butter", "cheese", "onion"],
    dislikes: [],
    dietary: ["vegan"],
    cookware: KITCHEN,
    request: { ...base },
  },
  {
    id: "five-days-from-two-proteins",
    probes: "stretch — the day count outruns a pantry that would be fine for two",
    expectFeasible: false,
    pantry: ["chicken thighs", "salmon fillet", "onion", "garlic", "rice", "lemon"],
    dislikes: [],
    dietary: [],
    cookware: KITCHEN,
    request: { ...base, days: 5 },
  },
];

/**
 * Content hash of the fixture set, recorded on every run.
 *
 * Same argument as `scorer_hash`: a pass rate is only comparable against
 * another run of the SAME questions. Edit a fixture and this moves, so two runs
 * that were never comparable cannot be silently averaged into one number.
 */
export function planFixtureSetHash(): string {
  return createHash("sha256").update(JSON.stringify(PLAN_FIXTURES)).digest("hex").slice(0, 8);
}
