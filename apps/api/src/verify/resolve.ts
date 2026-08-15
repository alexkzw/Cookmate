import lemmatize from "wink-lemmatizer";
import {
  INGREDIENTS,
  DIETARY_RULES,
  type IngredientAttrs,
  type IngredientEntry,
} from "@cookmate/shared";

/**
 * CANONICALISATION.
 *
 * Turns the free text a model writes ("tinned tomatoes", "chicken thighs") into
 * a canonical ingredient identity, so every downstream question is a lookup
 * rather than a string comparison.
 *
 * Two layers, on purpose:
 *
 *   1. Canonical — lemmatise, then match against the taxonomy. Exact, and the
 *      only layer that can answer dietary questions.
 *   2. Lexical fallback — the original normalise + head-noun rules, used when a
 *      term isn't in the taxonomy yet.
 *
 * The fallback is what makes this shippable without a complete ontology: the
 * taxonomy improves precision where it has coverage and changes nothing where
 * it doesn't. Terms that reach the fallback are recorded, and that list is the
 * work queue for growing the taxonomy.
 */

/** Strip punctuation and case. Deliberately does NOT de-pluralise — that's the lemmatiser's job. */
export function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lemmatise every word, so "tinned tomatoes" and "tinned tomato" converge.
 *
 * The hand-rolled de-pluralisation this replaces turned "tomatoes" into
 * "tomatoe" — it had rules for -ies and -ses/-xes/-ches but none for -oes, so
 * it fell through to stripping one "s". A lemmatiser knows English morphology,
 * including irregulars like leaves→leaf and knives→knife, which no amount of
 * hand-written suffix rules would have covered.
 */
export function lemmaKey(raw: string): string {
  const words = normalise(raw).split(" ").filter(Boolean);
  return words.map((w) => lemmatize.noun(w)).join(" ");
}

/** lemma key → entry. Built once at module load. */
const BY_KEY = new Map<string, IngredientEntry>();
for (const entry of INGREDIENTS) {
  for (const name of [entry.display, ...entry.synonyms]) {
    BY_KEY.set(lemmaKey(name), entry);
  }
  BY_KEY.set(lemmaKey(entry.id.replace(/_/g, " ")), entry);
}

/**
 * Terms that fell through to the lexical fallback.
 *
 * Deliberately module-level and unbounded-in-a-process: this is a work queue,
 * not telemetry. Read it after an eval run to see exactly which ingredients the
 * taxonomy is missing, and grow the taxonomy from evidence rather than guesswork.
 */
const unresolved = new Set<string>();

export function unresolvedTerms(): string[] {
  return [...unresolved].sort();
}

export function clearUnresolved(): void {
  unresolved.clear();
}

/**
 * Look up an ingredient's canonical entry.
 *
 * Tries the whole phrase first, then progressively drops leading modifiers so
 * "large free range egg" still finds "free range egg" and then "egg". Dropping
 * from the FRONT is deliberate: English compounds are head-final, so the last
 * word carries the identity ("coconut milk" is a milk-like thing made of
 * coconut, and the qualifier is what makes it not dairy).
 */
export function lookup(raw: string): IngredientEntry | undefined {
  const key = lemmaKey(raw);
  const direct = BY_KEY.get(key);
  if (direct) return direct;

  const words = key.split(" ").filter(Boolean);
  for (let start = 1; start < words.length; start += 1) {
    const candidate = BY_KEY.get(words.slice(start).join(" "));
    if (candidate) return candidate;
  }

  unresolved.add(key);
  return undefined;
}

export function attributesOf(raw: string): IngredientAttrs | undefined {
  return lookup(raw)?.attrs;
}

/**
 * Does this ingredient violate a dietary tag?
 *
 * Returns `null` when the answer is genuinely unknown — the ingredient isn't in
 * the taxonomy, so we have no attributes and will not guess. Silence beats a
 * confident wrong claim: the previous substring check told users that coconut
 * milk was dairy, and a false "you can't eat this" is worse than saying nothing
 * for a product whose entire pitch is that the badge can be trusted.
 */
export function violatesDietary(raw: string, tag: string): boolean | null {
  const rule = DIETARY_RULES[normalise(tag)];
  if (!rule) return null; // unknown tag — e.g. "keto", which we can't verify
  const attrs = attributesOf(raw);
  if (!attrs) return null; // unknown ingredient — don't assert either way
  return !rule(attrs);
}

/** True when both names resolve to the same canonical ingredient. */
export function sameIngredient(a: string, b: string): boolean {
  const ea = lookup(a);
  const eb = lookup(b);
  if (ea && eb) return ea.id === eb.id;
  return lemmaKey(a) === lemmaKey(b);
}

export const __testables = { normalise, lemmaKey, lookup, BY_KEY };
