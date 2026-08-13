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
];

export function getFixtures(ids?: string[]): Fixture[] {
  if (!ids || ids.length === 0) return FIXTURES;
  const found = FIXTURES.filter((f) => ids.includes(f.id));
  const missing = ids.filter((id) => !FIXTURES.some((f) => f.id === id));
  if (missing.length > 0) {
    throw new Error(`Unknown fixture(s): ${missing.join(", ")}`);
  }
  return found;
}
