import { randomUUID } from "node:crypto";
import type { Recipe } from "@cookmate/shared";
import { db } from "../db/index.js";
import { verifyRecipe } from "../verify/constraints.js";
import { FIXTURES, fixtureSetHash } from "./fixtures.js";
import { recordRun } from "./store.js";

/**
 * RE-SCORING, as distinct from re-generating.
 *
 * An eval run is two separate things bolted together:
 *
 *   generate — ask the model for a recipe        (slow, costs money, random)
 *   score    — run the verifier over that recipe (instant, free, deterministic)
 *
 * When the *scorer* changes, only the second half is invalid. The recipes the
 * model produced are still perfectly good evidence of what the model does — so
 * replaying them through the new verifier answers "what would this suite have
 * scored if my verifier had been correct?" without asking the model anything.
 *
 * That's the whole reason `recipe_json` is stored on every row. Storing the raw
 * artifact rather than only the verdict is what makes the verdict recomputable.
 *
 * WHAT A REPLAY IS AND ISN'T:
 *   it IS   a new measurement of the verifier
 *   it ISN'T a new sample of the model
 *
 * Replay the same suite five times and you get five identical results, because
 * the generations are fixed. `replayed_from` records the provenance so a replay
 * can never be mistaken for an independent run.
 */

export interface ReplayChange {
  fixtureId: string;
  repeatIndex: number;
  was: string;
  now: string;
}

export interface ReplayResult {
  suiteId: string;
  sourceSuiteId: string;
  scored: number;
  skipped: number;
  passedBefore: number;
  passedAfter: number;
  changes: ReplayChange[];
  fixtureDrift: boolean;
}

interface SourceRow {
  fixture_id: string;
  repeat_index: number;
  recipe_json: string;
  recipe_title: string | null;
  verification_ok: number | null;
  violation_kinds: string | null;
  fixture_set_hash: string | null;
  model: string;
  effort: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cache_status: string | null;
  cost_usd: number | null;
  latency_ms: number | null;
}

/** Newest suite that actually stored recipes, when none is named. */
export function latestScorableSuite(): string | undefined {
  const row = db
    .prepare(
      `SELECT suite_id FROM eval_runs
       WHERE recipe_json IS NOT NULL AND replayed_from IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { suite_id: string } | undefined;
  return row?.suite_id;
}

export function replaySuite(sourceSuiteId: string): ReplayResult {
  const rows = db
    .prepare(
      `SELECT fixture_id, repeat_index, recipe_json, recipe_title, verification_ok,
              violation_kinds, fixture_set_hash, model, effort,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              cache_status, cost_usd, latency_ms
       FROM eval_runs
       WHERE suite_id = ? AND recipe_json IS NOT NULL
       ORDER BY fixture_id, repeat_index`,
    )
    .all(sourceSuiteId) as SourceRow[];

  if (rows.length === 0) {
    throw new Error(`Suite "${sourceSuiteId}" has no stored recipes to re-score.`);
  }

  const suiteId = randomUUID().slice(0, 8);
  const currentHash = fixtureSetHash();
  const changes: ReplayChange[] = [];
  let scored = 0;
  let skipped = 0;
  let passedBefore = 0;
  let passedAfter = 0;
  let fixtureDrift = false;

  for (const row of rows) {
    const fixture = FIXTURES.find((f) => f.id === row.fixture_id);
    if (!fixture) {
      // The fixture was deleted since. Its recipe was generated against
      // constraints we no longer have, so scoring it would be meaningless.
      skipped += 1;
      continue;
    }
    // A changed fixture means the recipe was generated against a different
    // request. Still scoreable, but the comparison is no longer apples to
    // apples — surface it rather than quietly averaging it in.
    if (row.fixture_set_hash && row.fixture_set_hash !== currentHash) fixtureDrift = true;

    const recipe = JSON.parse(row.recipe_json) as Recipe;
    const verification = verifyRecipe(recipe, fixture.request);

    if (row.verification_ok === 1) passedBefore += 1;
    if (verification.ok) passedAfter += 1;

    if ((row.verification_ok === 1) !== verification.ok) {
      changes.push({
        fixtureId: row.fixture_id,
        repeatIndex: row.repeat_index,
        was: row.violation_kinds || "pass",
        now: verification.ok ? "pass" : verification.violations.map((v) => v.kind).join(","),
      });
    }

    recordRun({
      id: randomUUID(),
      suiteId,
      fixtureId: row.fixture_id,
      repeatIndex: row.repeat_index,
      fixtureSetHash: currentHash,
      verification,
      recipeTitle: row.recipe_title ?? undefined,
      recipeJson: row.recipe_json,
      replayedFrom: sourceSuiteId,
      // Generation cost is carried over unchanged. The re-scoring was free, but
      // this row still represents a recipe that cost that much to produce — and
      // "cost per passing recipe" is the number a routing decision turns on.
      // Filter on `replayed_from` when you want spend actually incurred today.
      usage: {
        model: row.model,
        effort: row.effort as never,
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        cacheReadTokens: row.cache_read_tokens ?? 0,
        cacheWriteTokens: row.cache_write_tokens ?? 0,
        cacheStatus: (row.cache_status ?? "NONE") as never,
        costUsd: row.cost_usd ?? 0,
        latencyMs: row.latency_ms ?? 0,
      },
    });
    scored += 1;
  }

  return {
    suiteId,
    sourceSuiteId,
    scored,
    skipped,
    passedBefore,
    passedAfter,
    changes,
    fixtureDrift,
  };
}
