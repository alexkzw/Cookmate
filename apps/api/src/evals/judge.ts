import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { CookRequest, Recipe } from "@cookmate/shared";
import { anthropic } from "../llm/client.js";
import { computeCostUsd } from "../llm/models.js";
import { db } from "../db/index.js";

/**
 * THE QUALITY JUDGE — deliberately the only model-graded thing in this repo.
 *
 * The house rule everywhere else is: never ask a model to check something a
 * computer can check exactly. Set membership and arithmetic belong in
 * `verify/constraints.ts`, with unit tests.
 *
 * But that rule has a second half people skip. The verifier can prove a recipe
 * is LEGAL — every ingredient accounted for, every appliance owned, the times
 * add up. It cannot say whether the recipe is any GOOD. Boiled pasta with salt
 * passes all seven checks and is miserable. That dimension is genuinely
 * undecidable, and undecidable is exactly where a judge earns its place.
 *
 * FOUR THINGS KEEP IT HONEST:
 *
 *  1. A different tier. The generator is Sonnet; the judge is Haiku. This does
 *     NOT eliminate self-preference — same provider, same training lineage —
 *     but it is the cheap half of the mitigation, and it makes running the
 *     judge on every stored recipe cost pennies.
 *  2. Blind. The judge is never told which model, arm or suite produced the
 *     recipe, so it cannot prefer a condition it has opinions about.
 *  3. Pinned. The model id is a constant here and is stored on every row. An
 *     unpinned judge silently redefines the metric when the provider ships an
 *     update, and you find out as an unexplained trend.
 *  4. Calibrated. `pnpm eval --label` records human scores and
 *     `--judge-report` prints the agreement. If the judge disagrees with the
 *     person, the judge is broken — the recipes are not.
 */

/** Pinned on purpose. Bump deliberately, and expect the metric to move. */
export const JUDGE_MODEL = "claude-haiku-4-5";

/**
 * Anchored rubric rather than a bare 1–5.
 *
 * "Rate this recipe out of five" invites the model to regress to 3–4 on
 * everything. Describing what each end of the scale looks like is what makes
 * the numbers comparable between runs.
 */
const JUDGE_PROMPT = `You are grading home recipes for quality. You are NOT checking whether the recipe is achievable — a separate deterministic system already verifies ingredients, equipment and timings, and you should ignore those concerns entirely.

Judge only whether this is a good thing to cook and a good thing to read.

Score three dimensions from 1 to 5.

appeal — would a competent home cook be pleased to eat this?
  1: bland or incoherent; flavours that don't belong together.
  3: fine. Edible, unremarkable, wouldn't be sought out.
  5: genuinely appetising; you'd want to cook it again.

technique — does the method make culinary sense?
  1: steps that would produce a bad result (searing in a cold pan, boiling a steak).
  3: workable but naive; nothing wrong, nothing considered.
  5: shows real craft — correct order, right heat, sensible resting or seasoning.

clarity — could someone follow this without prior knowledge?
  1: vague or ambiguous; missing an obvious step.
  3: followable with a bit of guessing.
  5: unambiguous, each step one clear action, no jargon left unexplained.

Be willing to use the whole scale. A 3 is a normal score. Reserve 5 for recipes you would recommend without qualification, and do not reward length — a short recipe done well beats a padded one.`;

const JudgeSchema = z
  .object({
    appeal: z.number().int().min(1).max(5),
    technique: z.number().int().min(1).max(5),
    clarity: z.number().int().min(1).max(5),
    /** One sentence. Kept because a score with no reason can't be argued with. */
    reason: z.string(),
  })
  .strict();

export type JudgeVerdict = z.infer<typeof JudgeSchema>;

export function judgePromptHash(): string {
  return createHash("sha256").update(JUDGE_PROMPT).digest("hex").slice(0, 8);
}

db.exec(`
CREATE TABLE IF NOT EXISTS judge_scores (
  id               TEXT PRIMARY KEY,
  eval_run_id      TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  judge_model      TEXT NOT NULL,
  judge_prompt_hash TEXT NOT NULL,
  appeal           INTEGER NOT NULL,
  technique        INTEGER NOT NULL,
  clarity          INTEGER NOT NULL,
  overall          REAL NOT NULL,
  reason           TEXT,
  cost_usd         REAL,
  UNIQUE(eval_run_id, judge_model, judge_prompt_hash)
);

-- Human labels are the ground truth the judge is measured against, which is
-- the only thing that turns "the model said 4" into evidence.
CREATE TABLE IF NOT EXISTS human_labels (
  eval_run_id TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  overall     INTEGER NOT NULL,
  note        TEXT
);
`);

/** Mean of the three dimensions. Stored so reports don't recompute it three ways. */
function overallOf(v: JudgeVerdict): number {
  return (v.appeal + v.technique + v.clarity) / 3;
}

export interface JudgeResult extends JudgeVerdict {
  overall: number;
  costUsd: number;
}

/**
 * Score one recipe.
 *
 * The request is included because "good" is partly contextual — a 20-minute
 * weeknight ask and a weekend project deserve different things — but the
 * generating model and arm are deliberately withheld.
 */
export async function judgeRecipe(recipe: Recipe, request: CookRequest): Promise<JudgeResult> {
  const message = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1024,
    system: [{ type: "text", text: JUDGE_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { format: zodOutputFormat(JudgeSchema) },
    messages: [
      {
        role: "user",
        content: [
          `They asked for: ${request.craving}`,
          `Servings: ${request.servings} · Time budget: ${request.maxMinutes} min · Effort: ${request.effort}`,
          "",
          "Recipe:",
          JSON.stringify(recipe, null, 2),
        ].join("\n"),
      },
    ],
  });

  const text = message.content
    .filter((b): b is { type: "text"; text: string; citations: null } => b.type === "text")
    .map((b) => b.text)
    .join("");

  const verdict = JudgeSchema.parse(JSON.parse(text));
  const costUsd = computeCostUsd(JUDGE_MODEL, {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  });

  return { ...verdict, overall: overallOf(verdict), costUsd };
}

export function recordJudgement(evalRunId: string, result: JudgeResult): void {
  db.prepare(
    `INSERT OR REPLACE INTO judge_scores
       (id, eval_run_id, judge_model, judge_prompt_hash, appeal, technique, clarity, overall, reason, cost_usd)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(),
    evalRunId,
    JUDGE_MODEL,
    judgePromptHash(),
    result.appeal,
    result.technique,
    result.clarity,
    result.overall,
    result.reason,
    result.costUsd,
  );
}

export function recordHumanLabel(evalRunId: string, overall: number, note?: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO human_labels (eval_run_id, overall, note) VALUES (?,?,?)`,
  ).run(evalRunId, overall, note ?? null);
}

export interface ScorableRow {
  id: string;
  fixture_id: string;
  repeat_index: number;
  recipe_json: string;
  output_tokens: number | null;
  model: string;
}

/** Rows with a stored recipe that this judge (model + prompt) hasn't scored. */
export function unjudgedRows(suiteId?: string, limit = 500): ScorableRow[] {
  return db
    .prepare(
      `SELECT e.id, e.fixture_id, e.repeat_index, e.recipe_json, e.output_tokens, e.model
       FROM eval_runs e
       LEFT JOIN judge_scores j
         ON j.eval_run_id = e.id AND j.judge_model = ? AND j.judge_prompt_hash = ?
       WHERE e.recipe_json IS NOT NULL
         AND j.id IS NULL
         AND (? IS NULL OR e.suite_id = ?)
       ORDER BY e.fixture_id, e.repeat_index
       LIMIT ?`,
    )
    .all(JUDGE_MODEL, judgePromptHash(), suiteId ?? null, suiteId ?? null, limit) as ScorableRow[];
}

/* ------------------------------------------------------------------ *
 * Analysis: is the judge any good, and is it measuring what it claims?
 * ------------------------------------------------------------------ */

/** Pearson correlation. Returns null when there's nothing to correlate. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = (xs[i] as number) - mx;
    const b = (ys[i] as number) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null; // no variance; correlation undefined
  return num / Math.sqrt(dx * dy);
}

export interface Calibration {
  n: number;
  exact: number;
  within1: number;
  meanAbsError: number;
  judgeMean: number;
  humanMean: number;
  correlation: number | null;
}

/**
 * How closely does the judge agree with a person?
 *
 * This is the number that decides whether any other judge output means
 * anything. A judge that doesn't track human labels is not a lenient judge or
 * a strict one — it is measuring something else, and its scores should not be
 * quoted.
 *
 * `meanAbsError` is the headline; `judgeMean - humanMean` separates two very
 * different failures: a judge that is systematically generous (fixable with a
 * rubric tweak) versus one that is uncorrelated (not fixable at all).
 */
export function calibration(): Calibration | null {
  const rows = db
    .prepare(
      `SELECT h.overall AS human, j.overall AS judge
       FROM human_labels h
       JOIN judge_scores j ON j.eval_run_id = h.eval_run_id
       WHERE j.judge_model = ? AND j.judge_prompt_hash = ?`,
    )
    .all(JUDGE_MODEL, judgePromptHash()) as Array<{ human: number; judge: number }>;

  if (rows.length === 0) return null;

  const human = rows.map((r) => r.human);
  const judge = rows.map((r) => r.judge);
  const diffs = rows.map((r) => Math.abs(r.judge - r.human));

  return {
    n: rows.length,
    exact: rows.filter((r) => Math.round(r.judge) === r.human).length,
    within1: diffs.filter((d) => d <= 1).length,
    meanAbsError: diffs.reduce((a, b) => a + b, 0) / rows.length,
    judgeMean: judge.reduce((a, b) => a + b, 0) / rows.length,
    humanMean: human.reduce((a, b) => a + b, 0) / rows.length,
    correlation: pearson(human, judge),
  };
}

export interface LengthBias {
  n: number;
  correlation: number | null;
  shortMean: number;
  longMean: number;
  medianTokens: number;
}

/**
 * THE LENGTH-BIAS PROBE.
 *
 * The best-documented failure of LLM-as-judge is mistaking verbosity for
 * quality. It is also the easiest to test for and almost nobody does, because
 * it needs a number you have to have kept: how long the output actually was.
 *
 * Correlating the judge's score against `output_tokens` turns "I hope it isn't
 * length-biased" into a measurement. A strong positive correlation means the
 * judge is partly grading length, and every score it has produced is suspect.
 *
 * The split means is the same finding in a form that survives a conversation:
 * "long recipes score 0.6 higher on average" lands where an r-value doesn't.
 * Neither is proof on its own — longer recipes might genuinely be better — but
 * a big gap is the signal to go and look.
 */
export function lengthBias(suiteId?: string): LengthBias | null {
  const rows = db
    .prepare(
      `SELECT j.overall AS score, e.output_tokens AS tokens
       FROM judge_scores j
       JOIN eval_runs e ON e.id = j.eval_run_id
       WHERE j.judge_model = ? AND j.judge_prompt_hash = ?
         AND e.output_tokens IS NOT NULL
         AND (? IS NULL OR e.suite_id = ?)`,
    )
    .all(JUDGE_MODEL, judgePromptHash(), suiteId ?? null, suiteId ?? null) as Array<{
      score: number;
      tokens: number;
    }>;

  if (rows.length < 3) return null;

  const sortedTokens = rows.map((r) => r.tokens).sort((a, b) => a - b);
  const median = sortedTokens[Math.floor(sortedTokens.length / 2)] as number;
  const short = rows.filter((r) => r.tokens <= median).map((r) => r.score);
  const long = rows.filter((r) => r.tokens > median).map((r) => r.score);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  return {
    n: rows.length,
    correlation: pearson(rows.map((r) => r.tokens), rows.map((r) => r.score)),
    shortMean: mean(short),
    longMean: mean(long),
    medianTokens: median,
  };
}

export interface JudgeByCondition {
  model: string;
  repair: number | null;
  n: number;
  appeal: number;
  technique: number;
  clarity: number;
  overall: number;
}

/** Mean quality per arm — the thing the verifier's pass rate cannot tell you. */
export function judgeByCondition(suiteId?: string): JudgeByCondition[] {
  return db
    .prepare(
      `SELECT e.model, e.repair,
              COUNT(*)          AS n,
              AVG(j.appeal)     AS appeal,
              AVG(j.technique)  AS technique,
              AVG(j.clarity)    AS clarity,
              AVG(j.overall)    AS overall
       FROM judge_scores j
       JOIN eval_runs e ON e.id = j.eval_run_id
       WHERE j.judge_model = ? AND j.judge_prompt_hash = ?
         AND (? IS NULL OR e.suite_id = ?)
       GROUP BY e.model, e.repair
       ORDER BY overall DESC`,
    )
    .all(JUDGE_MODEL, judgePromptHash(), suiteId ?? null, suiteId ?? null) as JudgeByCondition[];
}

export interface LabelCandidate {
  id: string;
  fixture_id: string;
  repeat_index: number;
  recipe_json: string;
}

/**
 * Recipes with a judge score but no human label, judge-score-shuffled.
 *
 * Ordered by a hash of the id rather than by score, so working through the list
 * doesn't walk you from best to worst — grading a sorted list anchors you and
 * quietly manufactures the agreement you were trying to measure.
 */
export function unlabelledRows(limit = 20): LabelCandidate[] {
  return db
    .prepare(
      `SELECT e.id, e.fixture_id, e.repeat_index, e.recipe_json
       FROM judge_scores j
       JOIN eval_runs e ON e.id = j.eval_run_id
       LEFT JOIN human_labels h ON h.eval_run_id = e.id
       WHERE h.eval_run_id IS NULL
         AND j.judge_model = ? AND j.judge_prompt_hash = ?
       ORDER BY substr(e.id, 8), e.id
       LIMIT ?`,
    )
    .all(JUDGE_MODEL, judgePromptHash(), limit) as LabelCandidate[];
}
