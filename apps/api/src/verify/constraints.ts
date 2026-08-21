import {
  UNIVERSAL_TOOLS,
  type CookRequest,
  type Recipe,
  type Verification,
  type Violation,
} from "@cookmate/shared";
import { lemmaKey, lookup, sameIngredient, violatesDietary } from "./resolve.js";

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

/**
 * Kitchen basics we assume without being told, as canonical ids.
 *
 * Ids rather than strings so "extra virgin olive oil" and "olive oil" are the
 * same staple without listing both.
 */
const STAPLE_IDS = new Set([
  "salt",
  "black_pepper",
  "water",
  "oil",
  "olive_oil",
  "butter",
  "flour",
  "sugar",
]);

/** Retained for terms the taxonomy doesn't cover yet. */
const STAPLE_LEXICAL = new Set([
  "salt", "sea salt", "table salt", "kosher salt",
  "pepper", "black pepper", "white pepper",
  "water", "oil", "cooking oil", "vegetable oil", "olive oil",
  "butter", "flour", "plain flour", "all-purpose flour",
  "sugar", "white sugar",
]);

/**
 * The canonical key for a name: punctuation stripped, case folded, every word
 * lemmatised. Replaces the hand-rolled de-pluralisation that turned "tomatoes"
 * into "tomatoe" and silently broke every tomato recipe.
 */
const normalise = lemmaKey;

/** Tokens of the pantry entry, so "chicken thighs" also indexes "chicken", "thigh". */
function expand(entry: string): string[] {
  const norm = normalise(entry);
  const parts = norm.split(" ").filter((p) => p.length > 2);
  return [norm, ...parts.map(normalise)];
}

export interface PantryIndex {
  /** Canonical ids of pantry items the taxonomy recognised. */
  ids: Set<string>;
  /** Lemma forms, for items it didn't. */
  lexical: Set<string>;
}

function buildPantryIndex(pantry: string[]): PantryIndex {
  const ids = new Set<string>();
  const lexical = new Set<string>();
  for (const item of pantry) {
    const entry = lookup(item);
    if (entry) ids.add(entry.id);
    for (const form of expand(item)) lexical.add(form);
  }
  return { ids, lexical };
}

/**
 * Independent recomputation of an ingredient's source. We never trust the
 * model's own `source` claim — we compare against it and flag disagreement.
 *
 * Canonical first: if both sides are in the taxonomy, this is id equality and
 * cannot be fooled by plurals, synonyms or compound nouns. Only terms the
 * taxonomy doesn't know fall through to the old lexical rules.
 */
function resolveSource(
  ingredientName: string,
  pantryIndex: PantryIndex,
): "pantry" | "staple" | "shopping" {
  const entry = lookup(ingredientName);
  if (entry) {
    if (STAPLE_IDS.has(entry.id)) return "staple";
    if (pantryIndex.ids.has(entry.id)) return "pantry";
    // Known ingredient, definitively not in the pantry — no need to guess.
    if (pantryIndex.ids.size > 0 || pantryIndex.lexical.size === 0) return "shopping";
  }

  const norm = normalise(ingredientName);
  if (STAPLE_LEXICAL.has(norm)) return "staple";
  if (pantryIndex.lexical.has(norm)) return "pantry";

  // A multi-word ingredient counts as pantry only if its head noun is present:
  // "chicken thigh" matches a pantry with "chicken thighs", but "chicken stock"
  // must not match a pantry containing only "chicken".
  const words = norm.split(" ").filter((w) => w.length > 2);
  const head = words[words.length - 1];
  if (words.length > 1 && head !== undefined && pantryIndex.lexical.has(head)) {
    // Guard the classic false positives: a qualifier that changes the product.
    const PRODUCT_QUALIFIERS = ["stock", "broth", "milk", "sauce", "powder", "oil", "paste", "juice"];
    if (!PRODUCT_QUALIFIERS.includes(head)) return "pantry";
  }
  return "shopping";
}

/** Dislike matching: canonical identity first, then loose string overlap. */
function matchesDislike(ingredientName: string, dislikes: string[]): string | null {
  for (const dislike of dislikes) {
    if (dislike.trim().length === 0) continue;
    if (sameIngredient(ingredientName, dislike)) return dislike;
    const a = normalise(ingredientName);
    const b = normalise(dislike);
    if (a.includes(b) || b.includes(a)) return dislike;
  }
  return null;
}

/**
 * The key to resolve an ingredient by, as distinct from how it is displayed.
 *
 * Falls back to `name` because recipes generated before `matchTerm` existed are
 * still stored and still replayable — an eval row from last week must not stop
 * scoring because the schema grew a field. An empty string is treated as absent
 * for the same reason: a model that emits `""` should degrade to the old
 * behaviour rather than resolve nothing.
 */
function matchKey(ing: Recipe["ingredients"][number]): string {
  const term = ing.matchTerm?.trim();
  return term && term.length > 0 ? term : ing.name;
}

export function verifyRecipe(recipe: Recipe, request: CookRequest): Verification {
  const violations: Violation[] = [];
  const uncertain = new Set<string>();
  const pantryIndex = buildPantryIndex(request.pantry);
  const shoppingList: string[] = [];
  let pantryUsedCount = 0;

  for (const ing of recipe.ingredients) {
    // Resolve on the canonical key, report with the display name. The user
    // reads "ripe tomatoes, diced"; the verifier matches "tomato".
    const key = matchKey(ing);
    const actual = resolveSource(key, pantryIndex);

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

    const disliked = matchesDislike(key, request.dislikes);
    if (disliked !== null) {
      violations.push({
        kind: "disliked_ingredient",
        detail: `"${ing.name}" conflicts with your dislike of "${disliked}".`,
        subject: ing.name,
      });
    }

    for (const tag of request.dietary) {
      const verdict = violatesDietary(key, tag);
      if (verdict === true) {
        violations.push({
          kind: "dietary_conflict",
          detail: `"${ing.name}" is not ${tag}.`,
          subject: ing.name,
        });
      } else if (verdict === null) {
        // We don't know what this ingredient is, so we don't claim it's a
        // problem. Surfaced as a question instead of asserted as a violation.
        uncertain.add(ing.name);
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
    uncertain: [...uncertain],
  };
}

/** Exported for unit tests. */
export const __testables = { normalise, resolveSource, buildPantryIndex, matchesDislike };
