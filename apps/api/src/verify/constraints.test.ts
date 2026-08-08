import { describe, it, expect } from "vitest";
import { CookRequestSchema, type CookRequest, type Recipe } from "@cookable/shared";
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
      { number: 1, instruction: "Dice the onion.", minutes: 3, uses: ["onion"] },
      { number: 2, instruction: "Sear the chicken.", minutes: 10, uses: ["chicken thigh"] },
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
      steps: [{ number: 1, instruction: "Braise.", minutes: 90, uses: [] }],
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
