import { describe, it, expect } from "vitest";
import { CookRequestSchema, type CookRequest, type Recipe } from "@cookmate/shared";
import { verifyRecipe, __testables } from "./constraints.js";

/**
 * These tests are the reason the verifier is deterministic code rather than a
 * second model call: correctness here is decidable, so it belongs in CI.
 */

const baseRequest: CookRequest = {
  craving: "something quick with chicken",
  servings: 2,
  maxMinutes: 30,
  effort: "moderate",
  willShop: false,
  pantry: ["chicken thighs", "onion", "rice", "soy sauce"],
  dislikes: ["coriander"],
  dietary: [],
  cookware: ["stovetop", "oven"],
};

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    title: "Quick chicken rice",
    summary: "Fast one-pan dinner.",
    cuisine: "Asian",
    servings: 2,
    prepMinutes: 10,
    cookMinutes: 15,
    difficulty: "easy",
    ingredients: [
      { name: "chicken thigh", quantity: 300, unit: "g", source: "pantry", substitute: null },
      { name: "onion", quantity: 1, unit: "piece", source: "pantry", substitute: null },
      { name: "rice", quantity: 200, unit: "g", source: "pantry", substitute: null },
      { name: "salt", quantity: 0, unit: "to_taste", source: "staple", substitute: null },
    ],
    steps: [
      {
        number: 1,
        instruction: "Dice the onion.",
        minutes: 3,
        handsOff: false,
        equipment: ["knife", "chopping board"],
        uses: ["onion"],
      },
      {
        number: 2,
        instruction: "Sear the chicken.",
        minutes: 10,
        handsOff: false,
        equipment: ["stovetop", "frying pan"],
        uses: ["chicken thigh"],
      },
    ],
    tips: [],
    ...overrides,
  };
}

describe("inbound request schema", () => {
  /**
   * Regression: the chat route used to accept an "optional" pantry via
   * `.partial()`. Zod's `.partial()` does NOT strip a field's `.default([])`,
   * so the field parsed to `[]` instead of `undefined` and silently defeated
   * the `?? readFromDatabase()` fallback — every recipe was generated against
   * an empty pantry. The route now omits these fields entirely.
   */
  it("rejects a client that tries to supply its own pantry", () => {
    // The base schema is .strict(), so omitting the field doesn't just ignore
    // a smuggled pantry — it fails loudly, which is the behaviour we want.
    const Inbound = CookRequestSchema.omit({ pantry: true, dislikes: true, dietary: true });
    const result = Inbound.safeParse({
      craving: "anything",
      servings: 2,
      maxMinutes: 30,
      effort: "minimal",
      willShop: false,
      pantry: ["smuggled in from the client"],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("still applies defaults for the fields the client does own", () => {
    const Inbound = CookRequestSchema.omit({ pantry: true, dislikes: true, dietary: true });
    const parsed = Inbound.parse({ craving: "anything" });
    expect(parsed.servings).toBe(2);
    expect(parsed.maxMinutes).toBe(30);
    expect(parsed.willShop).toBe(true);
  });
});

describe("normalisation", () => {
  const { normalise } = __testables;

  it("lowercases, trims and de-pluralises", () => {
    expect(normalise("  Brown Onions ")).toBe("brown onion");
    expect(normalise("Chicken Thighs")).toBe("chicken thigh");
    expect(normalise("Berries")).toBe("berry");
  });

  it("leaves words ending in double-s alone", () => {
    expect(normalise("watercress")).toBe("watercress");
  });
});

describe("source resolution", () => {
  const { resolveSource, buildPantryIndex } = __testables;
  const index = buildPantryIndex(["chicken thighs", "onion"]);

  it("matches a pantry item across plural and word order", () => {
    expect(resolveSource("chicken thigh", index)).toBe("pantry");
    expect(resolveSource("onion", index)).toBe("pantry");
  });

  it("treats basics as staples without being told", () => {
    expect(resolveSource("salt", index)).toBe("staple");
    expect(resolveSource("olive oil", index)).toBe("staple");
  });

  it("does NOT let a product qualifier inherit its head noun", () => {
    // The classic false positive: having "chicken" does not mean you have
    // chicken stock. Getting this wrong makes the app confidently unusable.
    expect(resolveSource("chicken stock", index)).toBe("shopping");
    expect(resolveSource("onion powder", index)).toBe("shopping");
  });

  it("falls through to shopping for anything unknown", () => {
    expect(resolveSource("gochujang", index)).toBe("shopping");
  });
});

describe("verifyRecipe", () => {
  it("passes a recipe that respects every constraint", () => {
    const result = verifyRecipe(recipe(), baseRequest);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.shoppingList).toEqual([]);
    expect(result.totalMinutes).toBe(25);
  });

  it("flags an ingredient the user must buy when they said they won't shop", () => {
    const r = recipe({
      ingredients: [
        ...recipe().ingredients,
        { name: "gochujang", quantity: 2, unit: "tbsp", source: "pantry", substitute: "sriracha" },
      ],
    });
    const result = verifyRecipe(r, baseRequest);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain("missing_ingredient");
    expect(result.shoppingList).toContain("gochujang");
  });

  it("ignores the model's own source claim and recomputes it", () => {
    // Model asserts "pantry" for something absent — the whole point of the
    // verifier is that this assertion carries no weight.
    const r = recipe({
      ingredients: [
        { name: "fish sauce", quantity: 1, unit: "tbsp", source: "pantry", substitute: null },
      ],
    });
    const result = verifyRecipe(r, { ...baseRequest, willShop: false });
    expect(result.shoppingList).toContain("fish sauce");
    expect(result.ok).toBe(false);
  });

  it("allows shopping items when the user is willing to shop", () => {
    const r = recipe({
      ingredients: [
        ...recipe().ingredients,
        { name: "gochujang", quantity: 2, unit: "tbsp", source: "shopping", substitute: null },
      ],
    });
    const result = verifyRecipe(r, { ...baseRequest, willShop: true });
    expect(result.ok).toBe(true);
    expect(result.shoppingList).toEqual(["gochujang"]);
  });

  it("flags a recipe that exceeds the time budget", () => {
    const result = verifyRecipe(recipe({ prepMinutes: 20, cookMinutes: 40 }), baseRequest);
    expect(result.violations.map((v) => v.kind)).toContain("over_time");
  });

  it("flags step times that exceed the stated total", () => {
    const r = recipe({
      steps: [
        {
          number: 1,
          instruction: "Braise.",
          minutes: 90,
          handsOff: true,
          equipment: ["oven"],
          uses: [],
        },
      ],
    });
    expect(verifyRecipe(r, baseRequest).violations.map((v) => v.kind)).toContain(
      "step_time_mismatch",
    );
  });

  it("flags a disliked ingredient even as a garnish", () => {
    const r = recipe({
      ingredients: [
        ...recipe().ingredients,
        { name: "coriander", quantity: 1, unit: "pinch", source: "shopping", substitute: null },
      ],
    });
    expect(verifyRecipe(r, baseRequest).violations.map((v) => v.kind)).toContain(
      "disliked_ingredient",
    );
  });

  it("flags meat in a vegetarian request", () => {
    const result = verifyRecipe(recipe(), { ...baseRequest, dietary: ["vegetarian"] });
    expect(result.violations.map((v) => v.kind)).toContain("dietary_conflict");
  });

  it("flags a servings mismatch", () => {
    expect(verifyRecipe(recipe({ servings: 4 }), baseRequest).violations.map((v) => v.kind)).toContain(
      "servings_mismatch",
    );
  });
});

describe("equipment", () => {
  it("rejects a recipe needing an appliance the user doesn't own", () => {
    const r = recipe({
      steps: [
        {
          number: 1,
          instruction: "Air fry the chicken until crisp.",
          minutes: 15,
          handsOff: true,
          equipment: ["air fryer"],
          uses: ["chicken thigh"],
        },
      ],
    });
    const result = verifyRecipe(r, baseRequest); // owns stovetop + oven only
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.kind === "missing_equipment");
    expect(violation?.subject).toBe("air fryer");
  });

  it("accepts the same recipe once the user owns the appliance", () => {
    const r = recipe({
      steps: [
        {
          number: 1,
          instruction: "Air fry the chicken until crisp.",
          minutes: 15,
          handsOff: true,
          equipment: ["air fryer"],
          uses: ["chicken thigh"],
        },
      ],
    });
    const result = verifyRecipe(r, { ...baseRequest, cookware: ["air fryer"] });
    expect(result.violations.some((v) => v.kind === "missing_equipment")).toBe(false);
    expect(result.equipmentUsed).toContain("air fryer");
  });

  it("never flags universal hand tools, even with no appliances declared", () => {
    const r = recipe({
      steps: [
        {
          number: 1,
          instruction: "Slice everything thinly and toss in a bowl.",
          minutes: 8,
          handsOff: false,
          equipment: ["knife", "chopping board", "mixing bowl"],
          uses: ["onion"],
        },
      ],
    });
    const result = verifyRecipe(r, { ...baseRequest, cookware: [] });
    expect(result.violations.some((v) => v.kind === "missing_equipment")).toBe(false);
  });

  it("reports one violation per missing appliance, not one per step", () => {
    const r = recipe({
      steps: [
        {
          number: 1,
          instruction: "Blend half the sauce.",
          minutes: 2,
          handsOff: false,
          equipment: ["blender"],
          uses: [],
        },
        {
          number: 2,
          instruction: "Blend the rest.",
          minutes: 2,
          handsOff: false,
          equipment: ["blender"],
          uses: [],
        },
      ],
    });
    const result = verifyRecipe(r, baseRequest);
    expect(result.violations.filter((v) => v.kind === "missing_equipment")).toHaveLength(1);
  });
});

describe("active vs passive time", () => {
  it("splits hands-on from walk-away time", () => {
    const r = recipe({
      prepMinutes: 10,
      cookMinutes: 50,
      steps: [
        {
          number: 1,
          instruction: "Brown the chicken.",
          minutes: 8,
          handsOff: false,
          equipment: ["stovetop", "frying pan"],
          uses: ["chicken thigh"],
        },
        {
          number: 2,
          instruction: "Cover and braise in the oven.",
          minutes: 45,
          handsOff: true,
          equipment: ["oven"],
          uses: [],
        },
        {
          number: 3,
          instruction: "Scatter over the spring onion and serve.",
          minutes: 2,
          handsOff: false,
          equipment: [],
          uses: ["onion"],
        },
      ],
    });
    const result = verifyRecipe(r, { ...baseRequest, maxMinutes: 60 });
    expect(result.activeMinutes).toBe(10); // 8 + 2
    expect(result.passiveMinutes).toBe(45);
    expect(result.totalMinutes).toBe(60);
  });

  it("reports zero passive time when every step is hands-on", () => {
    const result = verifyRecipe(recipe(), baseRequest);
    expect(result.passiveMinutes).toBe(0);
    expect(result.activeMinutes).toBe(13);
  });
});

/**
 * REGRESSION: the two false positives the eval harness found on its first run.
 *
 * Both were cases where the verifier confidently contradicted a correct recipe.
 * Neither was caught by the 23 tests that existed at the time, because those
 * tests covered the cases I thought of — and I never thought of "tomatoes" or
 * "coconut milk". These encode what the model actually produced.
 */
describe("regression: eval-discovered false positives", () => {
  const { normalise, resolveSource, buildPantryIndex } = __testables;

  describe("-oes plurals (eval fixture 'no-shopping', 3/3 false failures)", () => {
    it("lemmatises tomatoes and potatoes correctly", () => {
      // The old hand-rolled rule produced "tomatoe" — it handled -ies and
      // -ses/-xes/-ches but had no -oes case, so it stripped a single "s".
      expect(normalise("tomatoes")).toBe("tomato");
      expect(normalise("potatoes")).toBe("potato");
      expect(normalise("tinned tomatoes")).toBe("tinned tomato");
    });

    it("matches a pantry of 'tinned tomatoes' against a recipe's 'tinned tomato'", () => {
      const index = buildPantryIndex(["pasta", "tinned tomatoes", "garlic", "parmesan", "onion"]);
      expect(resolveSource("tinned tomato", index)).toBe("pantry");
      expect(resolveSource("parmesan", index)).toBe("pantry");
    });

    it("does not put a stocked ingredient on the shopping list", () => {
      const request: CookRequest = {
        ...baseRequest,
        willShop: false,
        pantry: ["pasta", "tinned tomatoes", "garlic", "parmesan", "onion"],
        dislikes: [],
        cookware: ["stovetop"],
      };
      const r = recipe({
        ingredients: [
          { name: "tinned tomato", quantity: 400, unit: "g", source: "pantry", substitute: null },
          { name: "pasta", quantity: 200, unit: "g", source: "pantry", substitute: null },
        ],
      });
      const result = verifyRecipe(r, request);
      expect(result.shoppingList).toEqual([]);
      expect(result.violations).toEqual([]);
    });
  });

  describe("compound nouns (eval fixture 'hard-veg-stovetop', 3/3 false failures)", () => {
    it("does not treat plant milks as dairy", () => {
      // "coconut milk".includes("milk") was true, so substring matching called
      // it a dairy conflict. Attribute lookup makes the question decidable.
      const request: CookRequest = {
        ...baseRequest,
        dietary: ["dairy-free"],
        pantry: ["coconut milk", "almond milk", "soy milk"],
        dislikes: [],
      };
      for (const milk of ["coconut milk", "almond milk", "soy milk"]) {
        const r = recipe({
          ingredients: [
            { name: milk, quantity: 400, unit: "ml", source: "pantry", substitute: null },
          ],
        });
        const result = verifyRecipe(r, request);
        expect(result.violations.map((v) => v.kind)).not.toContain("dietary_conflict");
        expect(result.shoppingList).toEqual([]);
      }
    });

    it("still catches actual dairy", () => {
      const request: CookRequest = { ...baseRequest, dietary: ["dairy-free"], dislikes: [] };
      const r = recipe({
        ingredients: [
          { name: "butter", quantity: 40, unit: "g", source: "staple", substitute: null },
        ],
      });
      const result = verifyRecipe(r, request);
      expect(result.violations.map((v) => v.kind)).toContain("dietary_conflict");
    });

    it("keeps the vegetarian and gluten-free traps working", () => {
      const request: CookRequest = {
        ...baseRequest,
        dietary: ["vegetarian", "gluten-free"],
        pantry: ["soy sauce", "fish sauce"],
        dislikes: [],
      };
      const r = recipe({
        ingredients: [
          { name: "soy sauce", quantity: 2, unit: "tbsp", source: "pantry", substitute: null },
          { name: "fish sauce", quantity: 1, unit: "tbsp", source: "pantry", substitute: null },
        ],
      });
      const kinds = verifyRecipe(r, request).violations.map((v) => v.kind);
      expect(kinds.filter((k) => k === "dietary_conflict")).toHaveLength(2);
    });
  });

  describe("uncertainty instead of confident guessing", () => {
    it("reports an unknown ingredient as uncertain rather than a violation", () => {
      const request: CookRequest = {
        ...baseRequest,
        dietary: ["vegan"],
        pantry: ["gochujang"],
        dislikes: [],
      };
      const r = recipe({
        ingredients: [
          { name: "gochujang", quantity: 1, unit: "tbsp", source: "pantry", substitute: null },
        ],
      });
      const result = verifyRecipe(r, request);
      expect(result.violations).toEqual([]);
      expect(result.uncertain).toContain("gochujang");
    });

    it("does not silently pass a dietary tag it cannot verify", () => {
      // "keto" has no rule, so every ingredient is unverifiable against it.
      const request: CookRequest = { ...baseRequest, dietary: ["keto"], dislikes: [] };
      const result = verifyRecipe(recipe(), request);
      expect(result.uncertain.length).toBeGreaterThan(0);
    });
  });
});
