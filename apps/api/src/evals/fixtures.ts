import { createHash } from "node:crypto";
import type { CookRequest } from "@cookmate/shared";

/**
 * THE EVAL SET.
 *
 * Every fixture here is *satisfiable* — a careful cook could produce a passing
 * recipe for all of them. That matters: an impossible case makes the pass rate
 * uninterpretable, because you can't tell a model failing from a fixture being
 * unfair. What several of them do instead is *tempt* a violation while staying
 * satisfiable — a trap ingredient in the pantry, a craving that invites an
 * appliance the kitchen doesn't have.
 *
 * `probes` records which verifier check the case is aimed at, so a regression
 * points at a mechanism rather than just a number.
 */

export interface Fixture {
  id: string;
  /** Which constraint this case is designed to stress. */
  probes: string;
  request: CookRequest;
  /**
   * What a correct system should produce.
   *
   * Every fixture here is satisfiable, so the expectation is always `ok: true`.
   * A failure therefore means one of two things — the model got it wrong, or the
   * verifier did — and the report flags it for inspection rather than folding it
   * into a pass rate that can't tell those apart.
   *
   * Note this is not a full confusion matrix, and can't be: the verifier's
   * ability to *detect* violations needs a known-bad recipe, which you can't
   * pre-declare when the recipe is generated fresh each run. That side is
   * covered by the unit tests, where the recipe is fixed.
   */
  expect: { ok: boolean };
}

/** Everything a CookRequest needs, minus the bits each fixture overrides. */
const base = {
  servings: 2,
  effort: "moderate" as const,
  dislikes: [] as string[],
  dietary: [] as string[],
};

export const FIXTURES: Fixture[] = [
  {
    id: "easy-chicken",
    probes: "baseline — nothing binding, everything should pass",
    expect: { ok: true },
    request: {
      ...base,
      craving: "something quick and comforting with chicken",
      maxMinutes: 45,
      willShop: true,
      pantry: [
        "chicken thigh", "onion", "garlic", "rice", "soy sauce",
        "egg", "carrot", "butter", "tinned tomatoes",
      ],
      cookware: ["stovetop", "oven"],
    },
  },
  {
    id: "hard-veg-stovetop",
    probes: "dietary_conflict — two trap ingredients, three tags, no oven",
    expect: { ok: true },
    request: {
      ...base,
      craving: "something warming and savoury with a rich umami depth",
      maxMinutes: 30,
      willShop: false,
      // soy sauce is forbidden by gluten-free; fish sauce by vegetarian. Both
      // are present and available, and the craving actively invites them.
      pantry: [
        "red lentils", "tinned chickpeas", "frozen spinach", "coconut milk",
        "sweet potato", "spring onion", "soy sauce", "fish sauce",
      ],
      dietary: ["vegetarian", "gluten-free", "dairy-free"],
      cookware: ["stovetop"],
    },
  },
  {
    id: "tight-time",
    probes: "over_time + step_time_mismatch — the known failure mode",
    expect: { ok: true },
    request: {
      ...base,
      craving: "a proper dinner, not a sandwich",
      maxMinutes: 15,
      willShop: true,
      pantry: ["egg", "spring onion", "rice", "frozen peas", "sesame oil"],
      cookware: ["stovetop"],
    },
  },
  {
    id: "no-shopping",
    probes: "missing_ingredient — willShop off with a deliberately short pantry",
    expect: { ok: true },
    request: {
      ...base,
      craving: "anything I can actually make right now",
      maxMinutes: 30,
      willShop: false,
      pantry: ["pasta", "tinned tomatoes", "garlic", "parmesan", "onion"],
      cookware: ["stovetop"],
    },
  },
  {
    id: "appliance-poor",
    probes: "missing_equipment — craving invites an oven the kitchen lacks",
    expect: { ok: true },
    request: {
      ...base,
      craving: "something roasted and crispy",
      maxMinutes: 40,
      willShop: true,
      pantry: ["potato", "chicken thigh", "olive oil", "rosemary", "lemon"],
      cookware: ["stovetop"],
    },
  },
  {
    id: "dislike-trap",
    probes: "disliked_ingredient — the disliked item is sitting in the pantry",
    expect: { ok: true },
    request: {
      ...base,
      craving: "a fresh, zingy noodle salad",
      maxMinutes: 25,
      willShop: true,
      pantry: [
        "rice noodles", "cucumber", "carrot", "peanut", "lime",
        "coriander", "fish sauce", "chilli",
      ],
      dislikes: ["coriander", "peanut"],
      cookware: ["stovetop", "kettle"],
    },
  },
  {
    id: "long-passive",
    probes: "active/passive split — most of the time should be hands-off",
    expect: { ok: true },
    request: {
      ...base,
      craving: "a slow-cooked beef stew worth waiting for",
      maxMinutes: 180,
      effort: "project",
      willShop: true,
      pantry: ["beef shin", "carrot", "onion", "celery", "tinned tomatoes", "red wine"],
      cookware: ["stovetop", "oven"],
    },
  },

  /**
   * TIME-ARITHMETIC BLOCK.
   *
   * `step_time_mismatch` is the only violation kind this app has ever produced
   * (4 for 4 at the time of writing), so it's the first thing the prompt will
   * be changed to fix — and a fix is unmeasurable if the baseline only trips it
   * three or four times. These cases deliberately over-sample the failure mode:
   * many stages, parallel work, and passive stretches that invite double
   * counting.
   *
   * The trade this makes is explicit: the *aggregate* pass rate across this set
   * is no longer representative of production traffic. That's fine, because the
   * aggregate isn't the instrument — the per-kind and per-fixture tables are.
   * An enriched suite is a diagnostic, not a simulation.
   */
  {
    id: "time-multi-component",
    probes: "step_time_mismatch — several components must be timed together",
    expect: { ok: true },
    request: {
      ...base,
      craving: "a proper roast dinner with a couple of sides",
      maxMinutes: 90,
      effort: "project",
      willShop: true,
      pantry: ["chicken", "potato", "carrot", "green beans", "butter", "flour", "stock"],
      cookware: ["stovetop", "oven"],
    },
  },
  {
    id: "time-parallel-work",
    probes: "step_time_mismatch — work overlaps, so naive summing overshoots",
    expect: { ok: true },
    request: {
      ...base,
      craving: "curry and rice, both ready at the same time",
      maxMinutes: 40,
      willShop: true,
      pantry: ["chicken thigh", "rice", "onion", "garlic", "ginger", "curry powder", "coconut milk"],
      cookware: ["stovetop"],
    },
  },
  {
    id: "time-proving-dough",
    probes: "step_time_mismatch + passive — a long hands-off stretch mid-recipe",
    expect: { ok: true },
    request: {
      ...base,
      craving: "fresh flatbreads to go with dinner",
      maxMinutes: 75,
      effort: "project",
      willShop: true,
      pantry: ["plain flour", "yoghurt", "yeast", "olive oil", "garlic", "butter"],
      cookware: ["stovetop", "oven"],
    },
  },
  {
    id: "time-tight-marinade",
    probes: "over_time — the obvious method needs more time than the budget",
    expect: { ok: true },
    request: {
      ...base,
      craving: "something marinated and grilled",
      maxMinutes: 30,
      willShop: true,
      pantry: ["chicken thigh", "yoghurt", "lemon", "garlic", "paprika", "flatbread"],
      cookware: ["stovetop", "grill"],
    },
  },
  {
    id: "time-many-small-steps",
    probes: "step_time_mismatch — lots of short stages that must still add up",
    expect: { ok: true },
    request: {
      ...base,
      craving: "a composed salad with several prepped elements and a dressing",
      maxMinutes: 35,
      willShop: true,
      pantry: [
        "chickpeas", "cucumber", "tomato", "red onion", "feta",
        "lemon", "olive oil", "mint", "pita",
      ],
      cookware: ["stovetop", "oven"],
    },
  },
];

/**
 * A content hash of the whole fixture set.
 *
 * Same reasoning as `promptHash()`: two suites are only comparable if they ran
 * the same cases. Add a fixture next month and the aggregate pass rate moves
 * for reasons that have nothing to do with the model — this makes that visible
 * instead of silent.
 */
export function fixtureSetHash(fixtures: Fixture[] = FIXTURES): string {
  const canonical = [...fixtures]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((f) => `${f.id}:${JSON.stringify(f.request)}`)
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}

export function getFixtures(ids?: string[]): Fixture[] {
  if (!ids || ids.length === 0) return FIXTURES;
  const found = FIXTURES.filter((f) => ids.includes(f.id));
  const missing = ids.filter((id) => !FIXTURES.some((f) => f.id === id));
  if (missing.length > 0) {
    throw new Error(`Unknown fixture(s): ${missing.join(", ")}`);
  }
  return found;
}
