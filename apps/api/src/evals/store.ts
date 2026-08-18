import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db, addColumnIfMissing } from "../db/index.js";
import { SYSTEM_PROMPT } from "../llm/prompts.js";
import type { Verification } from "@cookmate/shared";
import type { CallUsage } from "../llm/models.js";
import type { ErrorInfo } from "../llm/errors.js";

/**
 * Eval results live in their OWN table, not in `turns`.
 *
 * That separation is deliberate. `/api/stats` answers "are real people using
 * this, and what is it costing" — and a suite of 20 synthetic generations would
 * corrupt every number on it: the pass rate, the total spend, the cache hit
 * rate. Product telemetry measures the product; eval telemetry measures the
 * model. Mixing them means neither answers its question.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS eval_runs (
  id             TEXT PRIMARY KEY,
  suite_id       TEXT NOT NULL,     -- one id per invocation, so runs are comparable
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),

  fixture_id     TEXT NOT NULL,
  repeat_index   INTEGER NOT NULL,

  -- the condition under test
  model          TEXT NOT NULL,
  effort         TEXT NOT NULL,
  prompt_hash    TEXT NOT NULL,     -- see promptHash() below

  -- the result
  verification_ok INTEGER,
  violation_count INTEGER,
  violation_kinds TEXT,             -- comma-separated, for grouping
  recipe_title    TEXT,
  recipe_json     TEXT,
  error_code      TEXT,

  -- what it cost
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cache_status       TEXT,
  cost_usd           REAL,
  latency_ms         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_eval_suite ON eval_runs(suite_id);
CREATE INDEX IF NOT EXISTS idx_eval_fixture ON eval_runs(fixture_id);
`);

// Provenance, added after the first version of this table shipped.
addColumnIfMissing("eval_runs", "fixture_set_hash", "TEXT");
addColumnIfMissing("eval_runs", "git_sha", "TEXT");
// The full verdict, not just the kinds. Diagnosing the first two eval failures
// meant reading ingredient lists by hand because only `violation_kinds` was
// stored — a verifier that explains itself is worth nothing if you drop the
// explanation on the way to the database.
addColumnIfMissing("eval_runs", "verification_json", "TEXT");
// Set when a row was re-scored from a stored recipe rather than generated. A
// replay is a new measurement of the VERIFIER, not a new sample of the model —
// replaying twice yields identical results — so it must never be mistaken for
// an independent run when counting n.
addColumnIfMissing("eval_runs", "replayed_from", "TEXT");
// An error code alone is not diagnosable. See llm/errors.ts: the message says
// what happened, the request id is what the provider's support asks for, and
// `retryable` is what decides whether spending money again could have helped.
addColumnIfMissing("eval_runs", "error_message", "TEXT");
addColumnIfMissing("eval_runs", "error_status", "INTEGER");
addColumnIfMissing("eval_runs", "error_request_id", "TEXT");
addColumnIfMissing("eval_runs", "error_retryable", "INTEGER");
// Repair-loop outcome. first_pass_ok is the metric that matters: post-repair
// pass rate without it is unfalsifiable, because you cannot tell a recipe that
// was right first time from one that needed rescuing.
addColumnIfMissing("eval_runs", "attempts", "INTEGER");
addColumnIfMissing("eval_runs", "first_pass_ok", "INTEGER");
addColumnIfMissing("eval_runs", "first_pass_kinds", "TEXT");
// The first attempt's FULL verdict, not just its kinds. `verification_json`
// holds the final verdict, which for a repaired run is the passing one — so
// without this the exact defect repair fixed ("steps total 41 min, recipe
// claims 28") was computed, shown to the model, and then dropped on the floor.
addColumnIfMissing("eval_runs", "first_pass_verification_json", "TEXT");
// Whether the repair loop was ENABLED for this run. Part of the condition, not
// of the result: "sonnet + repair" and "sonnet alone" are two different arms,
// and without this column they group together and their pass rates average
// into a number that describes neither.
addColumnIfMissing("eval_runs", "repair", "INTEGER");
// A content hash of the scorer itself — see scorerHash() below.
addColumnIfMissing("eval_runs", "scorer_hash", "TEXT");

/**
 * Backfill `repair` for rows recorded before the column existed.
 *
 * Safe to derive, because `first_pass_ok` and the repair loop shipped in the
 * same commit: a row that has one was produced by a runner that had the other.
 * A row without it ran when repair did not exist, which is repair off — not
 * unknown. Idempotent, so it is a no-op on every boot after the first.
 *
 * Deliberately NOT backfilling `scorer_hash`. Some of those rows were graded by
 * the pre-taxonomy verifier, and stamping today's hash on them would assert
 * they were scored by code they never met — turning a gap in the record into a
 * false claim about it, which is the worse of the two. They keep a null hash
 * and fall back to the commit for grouping; see summariseByCondition.
 */
db.exec(`
  UPDATE eval_runs
     SET repair = CASE WHEN first_pass_ok IS NOT NULL THEN 1 ELSE 0 END
   WHERE repair IS NULL AND replayed_from IS NULL;

  UPDATE eval_runs
     SET repair = (SELECT src.repair FROM eval_runs src
                    WHERE src.suite_id = eval_runs.replayed_from LIMIT 1)
   WHERE repair IS NULL AND replayed_from IS NOT NULL;
`);

/**
 * The commit the suite ran against.
 *
 * Three things now identify a result: which prompt, which fixtures, which code.
 * Without the third, a verifier change looks exactly like a model change in the
 * table — and the verifier is the thing computing the metric.
 */
function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown"; // not a git checkout, or git isn't installed
  }
}

const GIT_SHA = gitSha();

/**
 * A content hash of the SCORER — the code that decides whether a recipe passed.
 *
 * `git_sha` was doing this job and doing it badly. It answers "which commit"
 * when the question is "which scorer", and those come apart constantly: the
 * three-arm comparison in the README ran across two commits whose diff touched
 * only the repair loop and the eval harness, never the verifier. git_sha
 * correctly refused to call those arms identical, and was correctly ignored,
 * which is a sign the key is measuring the wrong thing.
 *
 * Hashing the files that actually compute the verdict makes the guarantee
 * precise: equal hash means every run was graded by byte-identical logic, and
 * a differing hash means the metric moved under you. git_sha is still recorded
 * for forensics — it's how you find the commit — but it no longer gates
 * anything.
 *
 * Reads source rather than importing, deliberately: the taxonomy is data, and
 * a hash over `JSON.stringify(TAXONOMY)` would miss a changed predicate while a
 * hash over the module's behaviour is not something you can take.
 */
const SCORER_SOURCES = [
  "apps/api/src/verify/constraints.ts", // the checks
  "apps/api/src/verify/resolve.ts", // lemmatise -> taxonomy -> lexical fallback
  "packages/shared/src/ingredients.ts", // the canonical taxonomy the checks consult
  "packages/shared/src/constraints.ts", // Verification + the violation kinds
];

function scorerHash(): string {
  // .../apps/api/src/evals -> repo root
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const h = createHash("sha256");
  try {
    for (const rel of SCORER_SOURCES) {
      h.update(rel); // a renamed file must move the hash even if its bytes don't
      h.update(readFileSync(join(repoRoot, rel), "utf8"));
    }
  } catch {
    // Running from a build output where the sources aren't shipped. Better to
    // say so than to emit a hash of nothing that compares equal to everything.
    return "unknown";
  }
  return h.digest("hex").slice(0, 8);
}

export const SCORER_HASH = scorerHash();

/**
 * A content hash of the system prompt, recorded on every run.
 *
 * This is the piece that makes "did my prompt change help?" answerable. Without
 * it, results from before and after an edit are indistinguishable in the table
 * and you're comparing two numbers you can't attribute. Hashing rather than a
 * hand-maintained version string means it can never drift from reality — edit
 * one character and the hash moves on its own.
 */
export function promptHash(): string {
  return createHash("sha256").update(SYSTEM_PROMPT).digest("hex").slice(0, 8);
}

export interface EvalRow {
  id: string;
  suiteId: string;
  fixtureId: string;
  repeatIndex: number;
  usage?: CallUsage;
  verification?: Verification;
  recipeTitle?: string;
  recipeJson?: string;
  errorCode?: string;
  error?: ErrorInfo;
  attempts?: number;
  firstPassOk?: boolean;
  firstPassKinds?: string;
  /** The first attempt's full verdict, stored even when repair later fixed it. */
  firstPassVerification?: Verification;
  /** Was the repair loop enabled for this run? Part of the condition. */
  repair?: boolean;
  /** Present only when the call failed before any usage was reported. */
  model?: string;
  effort?: string;
  fixtureSetHash: string;
  /** Source suite id when this row was re-scored rather than generated. */
  replayedFrom?: string;
  /**
   * Overrides the current prompt hash. Only replays set this: the prompt is a
   * property of GENERATION, and a replay didn't generate anything — so it must
   * carry the hash of the prompt that actually produced the recipe, not
   * whatever SYSTEM_PROMPT happens to say today.
   */
  promptHashOverride?: string;
}

export function recordRun(row: EvalRow): void {
  const v = row.verification;
  db.prepare(
    `INSERT INTO eval_runs (
       id, suite_id, fixture_id, repeat_index,
       model, effort, prompt_hash, fixture_set_hash, git_sha, scorer_hash, repair, replayed_from,
       verification_ok, violation_count, violation_kinds, verification_json, recipe_title, recipe_json, error_code,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cache_status, cost_usd, latency_ms,
       error_message, error_status, error_request_id, error_retryable,
       attempts, first_pass_ok, first_pass_kinds, first_pass_verification_json
     ) VALUES (?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?)`,
  ).run(
    row.id,
    row.suiteId,
    row.fixtureId,
    row.repeatIndex,
    row.usage?.model ?? row.model ?? "unknown",
    row.usage?.effort ?? row.effort ?? "unknown",
    row.promptHashOverride ?? promptHash(),
    row.fixtureSetHash,
    GIT_SHA,
    SCORER_HASH,
    row.repair === undefined ? null : row.repair ? 1 : 0,
    row.replayedFrom ?? null,
    v ? (v.ok ? 1 : 0) : null,
    v ? v.violations.length : null,
    v ? [...new Set(v.violations.map((x) => x.kind))].sort().join(",") : null,
    v ? JSON.stringify(v) : null,
    row.recipeTitle ?? null,
    row.recipeJson ?? null,
    row.errorCode ?? null,
    row.usage?.inputTokens ?? null,
    row.usage?.outputTokens ?? null,
    row.usage?.cacheReadTokens ?? null,
    row.usage?.cacheWriteTokens ?? null,
    row.usage?.cacheStatus ?? null,
    row.usage?.costUsd ?? null,
    row.usage?.latencyMs ?? null,
    row.error?.message ?? null,
    row.error?.status ?? null,
    row.error?.requestId ?? null,
    row.error ? (row.error.retryable ? 1 : 0) : null,
    row.attempts ?? null,
    row.firstPassOk === undefined ? null : row.firstPassOk ? 1 : 0,
    row.firstPassKinds ?? null,
    row.firstPassVerification ? JSON.stringify(row.firstPassVerification) : null,
  );
}

export interface ConditionSummary {
  model: string;
  effort: string;
  prompt_hash: string;
  fixture_set_hash: string;
  scorer_hash: string;
  repair: number | null;
  git_shas: string;
  n: number;
  passed: number;
  errors: number;
  pass_rate: number;
  avg_cost: number;
  avg_latency: number;
}

/** Pass rate and spend per condition — the headline table. */
export function summariseByCondition(suiteId?: string): ConditionSummary[] {
  return db
    .prepare(
      `SELECT model, effort, prompt_hash, fixture_set_hash, repair,
              -- Fall back to the commit for rows predating scorer_hash. Merging
              -- them instead would claim runs were graded identically when the
              -- record can't support it; the commit is the coarse key we used
              -- to rely on, and over-splitting is the safe direction to fail.
              COALESCE(scorer_hash, 'git:' || git_sha) AS scorer_hash,
              -- Not a grouping key. Two commits that leave the scorer untouched
              -- are the same condition; listing them keeps the audit trail
              -- without splitting one arm into two rows.
              group_concat(DISTINCT git_sha)             AS git_shas,
              COUNT(*)                                   AS n,
              COALESCE(SUM(verification_ok = 1), 0)      AS passed,
              COALESCE(SUM(error_code IS NOT NULL), 0)   AS errors,
              COALESCE(AVG(verification_ok = 1), 0)      AS pass_rate,
              COALESCE(AVG(cost_usd), 0)                 AS avg_cost,
              COALESCE(AVG(latency_ms), 0)               AS avg_latency
       FROM eval_runs
       WHERE (? IS NULL OR suite_id = ?)
       GROUP BY model, effort, prompt_hash, fixture_set_hash,
                COALESCE(scorer_hash, 'git:' || git_sha), repair
       ORDER BY avg_cost`,
    )
    .all(suiteId ?? null, suiteId ?? null) as ConditionSummary[];
}

export interface KindCount {
  violation_kind: string;
  hits: number;
}

/**
 * Failures grouped by violation kind. This is the diagnostic view — a pass rate
 * says something broke, the kind says what, and only the kind tells you whether
 * a prompt change fixed the thing you aimed it at.
 */
export function summariseByKind(suiteId?: string): KindCount[] {
  return db
    .prepare(
      `SELECT TRIM(kind.value) AS violation_kind, COUNT(*) AS hits
       FROM eval_runs, json_each('["' || REPLACE(violation_kinds, ',', '","') || '"]') kind
       WHERE violation_kinds IS NOT NULL AND violation_kinds != ''
         AND (? IS NULL OR suite_id = ?)
       GROUP BY violation_kind
       ORDER BY hits DESC`,
    )
    .all(suiteId ?? null, suiteId ?? null) as KindCount[];
}

export interface FixtureSummary {
  fixture_id: string;
  n: number;
  passed: number;
  kinds: string | null;
}

/** Per-fixture view — shows which cases are carrying the failure rate. */
export function summariseByFixture(suiteId?: string): FixtureSummary[] {
  return db
    .prepare(
      `SELECT fixture_id,
              COUNT(*)                              AS n,
              COALESCE(SUM(verification_ok = 1), 0) AS passed,
              group_concat(DISTINCT violation_kinds) AS kinds
       FROM eval_runs
       WHERE (? IS NULL OR suite_id = ?)
       GROUP BY fixture_id
       ORDER BY passed * 1.0 / COUNT(*), fixture_id`,
    )
    .all(suiteId ?? null, suiteId ?? null) as FixtureSummary[];
}

export interface Unexpected {
  fixture_id: string;
  repeat_index: number;
  expected_ok: number;
  verification_ok: number | null;
  error_code: string | null;
  details: string | null;
}

/**
 * Runs whose outcome disagreed with the fixture's expectation.
 *
 * a satisfiable fixture that failed is a defect somewhere, and the violation
 * detail tells you in one line whether to look at the prompt or the verifier.
 */
export function unexpectedRuns(suiteId: string | undefined, expected: Map<string, boolean>): Unexpected[] {
  const rows = db
    .prepare(
      `SELECT fixture_id, repeat_index, verification_ok, error_code, verification_json
       FROM eval_runs WHERE (? IS NULL OR suite_id = ?) ORDER BY fixture_id, repeat_index`,
    )
    .all(suiteId ?? null, suiteId ?? null) as Array<{
      fixture_id: string; repeat_index: number; verification_ok: number | null;
      error_code: string | null; verification_json: string | null;
    }>;

  const out: Unexpected[] = [];
  for (const r of rows) {
    const want = expected.get(r.fixture_id);
    if (want === undefined) continue;
    const got = r.error_code === null && r.verification_ok === 1;
    if (got === want) continue;
    let details: string | null = null;
    if (r.verification_json) {
      const v = JSON.parse(r.verification_json) as { violations: Array<{ kind: string; detail: string }> };
      details = v.violations.map((x) => `${x.kind}: ${x.detail}`).join(" | ");
    }
    out.push({
      fixture_id: r.fixture_id, repeat_index: r.repeat_index,
      expected_ok: want ? 1 : 0, verification_ok: r.verification_ok,
      error_code: r.error_code, details,
    });
  }
  return out;
}

export const CURRENT_GIT_SHA = GIT_SHA;

/**
 * Has this exact replay already been recorded?
 *
 * Re-scoring is deterministic: same recipes, same verifier, same fixtures gives
 * bit-identical verdicts. A second replay therefore adds no information and
 * actively harms the analysis, because `summariseByCondition` groups on these
 * very columns — two replays of one suite would merge into a single row showing
 * double the n, overstating a sample that never grew.
 *
 * Note the asymmetry with generation, which is deliberately NOT guarded:
 * generation is stochastic, so running it again is a legitimate way to collect
 * more samples. Guard idempotency where the operation is deterministic; allow
 * repetition where it is stochastic.
 *
 * Keyed on `scorer_hash` rather than `git_sha`. The commit was a proxy for "did
 * the verifier change", and it over-fired: any unrelated commit made an
 * identical replay look novel. The scorer hash asks the question directly.
 */
export function findExistingReplay(
  sourceSuiteId: string,
  fixtureSetHash: string,
): { suite_id: string; created_at: string; n: number } | undefined {
  return db
    .prepare(
      `SELECT suite_id, MIN(created_at) AS created_at, COUNT(*) AS n
       FROM eval_runs
       WHERE replayed_from = ? AND scorer_hash = ? AND fixture_set_hash = ?
       GROUP BY suite_id
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sourceSuiteId, SCORER_HASH, fixtureSetHash) as
    | { suite_id: string; created_at: string; n: number }
    | undefined;
}

export interface RepairSummary {
  model: string;
  repair: number | null;
  n: number;
  first_pass: number;
  final_pass: number;
  repaired: number;
  total_cost: number;
}

/**
 * First-pass vs final pass rate, with what the extra attempts cost.
 *
 * The pair is the whole point. A post-repair pass rate on its own says nothing:
 * a model that never fails and a model rescued on every run both report 100%.
 * The gap between the two columns is the repair loop's actual contribution.
 */
export function summariseRepair(suiteId?: string): RepairSummary[] {
  return db
    .prepare(
      `SELECT model, repair,
              COUNT(*)                                          AS n,
              COALESCE(SUM(first_pass_ok = 1), 0)               AS first_pass,
              COALESCE(SUM(verification_ok = 1), 0)             AS final_pass,
              COALESCE(SUM(attempts > 1), 0)                    AS repaired,
              COALESCE(SUM(cost_usd), 0)                        AS total_cost
       FROM eval_runs
       WHERE (? IS NULL OR suite_id = ?) AND replayed_from IS NULL
       GROUP BY model, repair`,
    )
    .all(suiteId ?? null, suiteId ?? null) as RepairSummary[];
}

export interface FirstPassFailure {
  fixture_id: string;
  repeat_index: number;
  kinds: string;
  details: string;
  attempts: number | null;
  rescued: boolean;
}

/**
 * Every run whose FIRST attempt failed, with what the verifier actually said.
 *
 * This is the view the repair loop made necessary. Once repair is on, the final
 * verdict is mostly "pass", so the headline table stops showing you where the
 * model is weak — the failures are still happening, they're just being cleaned
 * up before anyone sees them. A 100% pass rate with a 19% repair rate is a very
 * different system from a 100% pass rate with a 0% repair rate, and only this
 * table tells them apart.
 */
export function firstPassFailures(suiteId?: string): FirstPassFailure[] {
  const rows = db
    .prepare(
      `SELECT fixture_id, repeat_index, first_pass_kinds, first_pass_verification_json,
              attempts, verification_ok
       FROM eval_runs
       WHERE first_pass_ok = 0 AND (? IS NULL OR suite_id = ?)
       ORDER BY fixture_id, repeat_index`,
    )
    .all(suiteId ?? null, suiteId ?? null) as Array<{
      fixture_id: string; repeat_index: number; first_pass_kinds: string | null;
      first_pass_verification_json: string | null; attempts: number | null;
      verification_ok: number | null;
    }>;

  return rows.map((r) => {
    let details = "";
    if (r.first_pass_verification_json) {
      const v = JSON.parse(r.first_pass_verification_json) as {
        violations: Array<{ kind: string; detail: string }>;
      };
      details = v.violations.map((x) => x.detail).join(" | ");
    }
    return {
      fixture_id: r.fixture_id,
      repeat_index: r.repeat_index,
      kinds: r.first_pass_kinds ?? "",
      details,
      attempts: r.attempts,
      rescued: (r.attempts ?? 1) > 1 && r.verification_ok === 1,
    };
  });
}

export function latestSuiteId(): string | undefined {
  const row = db
    .prepare(`SELECT suite_id FROM eval_runs ORDER BY created_at DESC LIMIT 1`)
    .get() as { suite_id: string } | undefined;
  return row?.suite_id;
}
