import {
  UNIVERSAL_TOOLS,
  type CookRequest,
  type Recipe,
  type Verification,
  type Violation,
} from "@cookmate/shared";

/**
 * THE CONSTRAINT VERIFIER — the core of the product.
 *
 * This runs in plain TypeScript with no model call. That is the entire point.
 *
 * Asking a model "did you follow the rules?" is asking the same system that
 * made the mistake to notice the mistake, and it shares the blind spot by
 * construction. Every check here is arithmetic or set membership, so it is
 * fast, free, deterministic, and unit-testable — and a violation is a fact,
 * not an opinion.
 *
 * A second, LLM-based reviewer is still worth adding later for the genuinely
 * fuzzy question ("is this recipe actually any good?"), but it should never be
 * responsible for anything a computer can check exactly.
 */

/** Kitchen basics we assume without being told. Deliberately short. */
const STAPLES = new Set([
  "salt",
  "sea salt",
  "table salt",
  "kosher salt",
  "pepper",
  "black pepper",
  "white pepper",
  "water",
  "oil",
  "cooking oil",
  "vegetable oil",
  "olive oil",
  "butter",
  "flour",
  "plain flour",
  "all-purpose flour",
  "sugar",
  "white sugar",
]);

/** Strip plurals, punctuation, and case so "Brown Onions" matches "onion". */
function normalise(raw: string): string {
  let s = raw.toLowerCase().trim();
  s = s.replace(/[^a-z\s-]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  // Naive de-pluralisation is sufficient here and stays predictable.
  if (s.endsWith("ies") && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith("es") && s.length > 3 && /(sh|ch|s|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("s") && !s.endsWith("ss") && s.length > 3) s = s.slice(0, -1);
  return s;
}

/** Tokens of the pantry entry, so "chicken thighs" also indexes "chicken", "thigh". */
function expand(entry: string): string[] {
  const norm = normalise(entry);
  const parts = norm.split(" ").filter((p) => p.length > 2);
  return [norm, ...parts.map(normalise)];
}

function buildPantryIndex(pantry: string[]): Set<string> {
  const index = new Set<string>();
  for (const item of pantry) for (const form of expand(item)) index.add(form);
  return index;
}

/**
 * Independent recomputation of an ingredient's source. We never trust the
 * model's own `source` claim — we compare against it and flag disagreement.
 */
function resolveSource(
  ingredientName: string,
  pantryIndex: Set<string>,
): "pantry" | "staple" | "shopping" {
  const norm = normalise(ingredientName);
  if (STAPLES.has(norm)) return "staple";
  if (pantryIndex.has(norm)) return "pantry";

  // A multi-word ingredient counts as pantry only if its head noun is present:
  // "chicken thigh" matches a pantry with "chicken thighs", but "chicken stock"
  // must not match a pantry containing only "chicken".
  const words = norm.split(" ").filter((w) => w.length > 2);
  const head = words[words.length - 1];
  if (words.length > 1 && head !== undefined && pantryIndex.has(head)) {
    // Guard the classic false positives: a qualifier that changes the product.
    const PRODUCT_QUALIFIERS = ["stock", "broth", "milk", "sauce", "powder", "oil", "paste", "juice"];
    if (!PRODUCT_QUALIFIERS.includes(head)) return "pantry";
  }
  return "shopping";
}

function containsAny(haystack: string, needles: string[]): string | null {
  const norm = normalise(haystack);
  for (const n of needles) {
    const nn = normalise(n);
    if (nn.length === 0) continue;
    if (norm === nn || norm.includes(nn) || nn.includes(norm)) return n;
  }
  return null;
}

/** Ingredients that violate common dietary tags. Extend as real users hit gaps. */
const DIETARY_FORBIDDEN: Record<string, string[]> = {
  vegetarian: ["chicken", "beef", "pork", "lamb", "bacon", "ham", "fish", "salmon", "tuna", "prawn", "shrimp", "anchovy", "gelatin", "chicken stock", "beef stock", "fish sauce"],
  vegan: ["chicken", "beef", "pork", "lamb", "bacon", "ham", "fish", "salmon", "tuna", "prawn", "shrimp", "anchovy", "gelatin", "chicken stock", "beef stock", "fish sauce", "milk", "butter", "cheese", "cream", "egg", "honey", "yoghurt", "yogurt"],
  "dairy-free": ["milk", "butter", "cheese", "cream", "yoghurt", "yogurt", "parmesan", "mozzarella"],
  "gluten-free": ["flour", "plain flour", "bread", "pasta", "soy sauce", "couscous", "barley", "breadcrumb"],
  pescatarian: ["chicken", "beef", "pork", "lamb", "bacon", "ham", "chicken stock", "beef stock"],
};

export function verifyRecipe(recipe: Recipe, request: CookRequest): Verification {
  const violations: Violation[] = [];
  const pantryIndex = buildPantryIndex(request.pantry);
  const shoppingList: string[] = [];
  let pantryUsedCount = 0;

  for (const ing of recipe.ingredients) {
    const actual = resolveSource(ing.name, pantryIndex);

    if (actual === "pantry" || actual === "staple") pantryUsedCount += 1;
    if (actual === "shopping") {
      shoppingList.push(ing.name);
      // Hard failure: they told us they aren't going to the shop.
      if (!request.willShop) {
        violations.push({
          kind: "missing_ingredient",
          detail: `"${ing.name}" is not in the pantry, but you said you don't want to shop.`,
          subject: ing.name,
        });
      }
    }

    const disliked = containsAny(ing.name, request.dislikes);
    if (disliked !== null) {
      violations.push({
        kind: "disliked_ingredient",
        detail: `"${ing.name}" conflicts with your dislike of "${disliked}".`,
        subject: ing.name,
      });
    }

    for (const tag of request.dietary) {
      const forbidden = DIETARY_FORBIDDEN[normalise(tag)];
      if (!forbidden) continue;
      const hit = containsAny(ing.name, forbidden);
      if (hit !== null) {
        violations.push({
          kind: "dietary_conflict",
          detail: `"${ing.name}" is not ${tag}.`,
          subject: ing.name,
        });
      }
    }
  }

  /**
   * EQUIPMENT CHECK.
   *
   * Note how much simpler this is than the ingredient check above: because
   * `equipment` is a Zod enum in the schema, the model physically cannot emit
   * a name outside the known vocabulary, so this is exact set membership with
   * no normalisation and no false-positive rules. Constraining the vocabulary
   * at the schema is what buys that.
   */
  const alwaysAvailable = new Set<string>(UNIVERSAL_TOOLS);
  const owned = new Set<string>(request.cookware);
  const equipmentUsed = new Set<string>();
  const alreadyFlagged = new Set<string>();

  for (const step of recipe.steps) {
    for (const item of step.equipment) {
      if (alwaysAvailable.has(item)) continue;
      if (owned.has(item)) {
        equipmentUsed.add(item);
        continue;
      }
      // One violation per missing appliance, not one per step that uses it.
      if (alreadyFlagged.has(item)) continue;
      alreadyFlagged.add(item);
      violations.push({
        kind: "missing_equipment",
        detail: `Step ${step.number} needs a ${item}, which isn't in your kitchen.`,
        subject: item,
      });
    }
  }

  /**
   * ACTIVE vs PASSIVE TIME.
   *
   * Computed here from the steps rather than requested from the model: it's
   * exact arithmetic, so asking for it would only create something else to
   * verify. "40 minutes, 8 hands-on" is often the number that decides whether
   * someone cooks at all.
   */
  let activeMinutes = 0;
  let passiveMinutes = 0;
  for (const step of recipe.steps) {
    if (step.handsOff) passiveMinutes += step.minutes;
    else activeMinutes += step.minutes;
  }

  const totalMinutes = recipe.prepMinutes + recipe.cookMinutes;
  if (totalMinutes > request.maxMinutes) {
    violations.push({
      kind: "over_time",
      detail: `Takes ${totalMinutes} minutes but you have ${request.maxMinutes}.`,
      subject: null,
    });
  }

  // Steps can overlap (marinating while chopping), so we only flag a step sum
  // that *exceeds* the stated total — that's an inconsistency, not overlap.
  const stepMinutes = recipe.steps.reduce((sum, s) => sum + s.minutes, 0);
  if (stepMinutes > totalMinutes) {
    violations.push({
      kind: "step_time_mismatch",
      detail: `Steps add up to ${stepMinutes} minutes but the recipe claims ${totalMinutes}.`,
      subject: null,
    });
  }

  if (recipe.servings !== request.servings) {
    violations.push({
      kind: "servings_mismatch",
      detail: `Serves ${recipe.servings}, you asked for ${request.servings}.`,
      subject: null,
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    shoppingList: [...new Set(shoppingList)],
    pantryUsedCount,
    totalMinutes,
    activeMinutes,
    passiveMinutes,
    equipmentUsed: [...equipmentUsed],
  };
}

/** Exported for unit tests. */
export const __testables = { normalise, resolveSource, buildPantryIndex };
