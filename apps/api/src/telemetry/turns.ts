import { randomUUID } from "node:crypto";
import type { CookRequest, Recipe, Verification } from "@cookmate/shared";
import { db } from "../db/index.js";
import type { CallUsage } from "../llm/models.js";
import type { ErrorInfo } from "../llm/errors.js";
import { promptHash } from "../llm/prompts.js";
import { SCORER_HASH } from "../verify/provenance.js";

/**
 * Turn logging.
 *
 * Built before the UI on purpose. "How do you know they still use it?" is only
 * answerable with data you decided to collect on day one — a testimonial is
 * not evidence, and you cannot backfill usage history.
 *
 * A row is opened when generation starts and completed when it finishes, so
 * failures and abandoned requests are recorded too. Silent failure is exactly
 * the thing you most want to see in the stats.
 */

export function openTurn(
  userId: string,
  request: CookRequest,
  meta: { userTurn: string; parentTurnId?: string | null } ,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO turns
       (id, user_id, craving, servings, max_minutes, effort, will_shop, pantry_json, cookware_json,
        user_turn, parent_turn_id, prompt_hash, scorer_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    request.craving,
    request.servings,
    request.maxMinutes,
    request.effort,
    request.willShop ? 1 : 0,
    JSON.stringify(request.pantry),
    JSON.stringify(request.cookware),
    meta.userTurn,
    meta.parentTurnId ?? null,
    // Recorded at OPEN, not at completion: this is a property of the request we
    // are about to send, and a turn that fails still ran on a specific prompt.
    // Stamping it only on success would lose the provenance of exactly the
    // turns whose provenance you most want — the ones that went wrong.
    promptHash(),
    SCORER_HASH,
  );
  return id;
}

export interface ConversationTurn {
  userTurn: string;
  recipeJson: string;
}

/**
 * Rebuild the conversation leading up to a turn, oldest first.
 *
 * Walks `parent_turn_id` backwards and returns only turns that actually
 * produced a recipe — an errored turn has no assistant reply, and inventing one
 * would put words in the model's mouth.
 *
 * Scoped by user_id: a turn id is a UUID, but "unguessable" is not an
 * authorisation model, and conversation history is the most sensitive thing
 * this table holds.
 *
 * Bounded at `limit` turns. History is the part of the prompt that grows
 * without a natural ceiling, and cost grows with it — the cap is what keeps a
 * long conversation from quietly becoming the most expensive request you serve.
 */
export function conversationHistory(
  userId: string,
  leafTurnId: string,
  limit = 6,
): ConversationTurn[] {
  const row = db.prepare(
    `SELECT user_turn, recipe_json, parent_turn_id FROM turns WHERE id = ? AND user_id = ?`,
  );

  const chain: ConversationTurn[] = [];
  let cursor: string | null = leafTurnId;
  const seen = new Set<string>();

  while (cursor && chain.length < limit) {
    if (seen.has(cursor)) break; // corrupt parent chain; refuse to loop forever
    seen.add(cursor);

    const turn = row.get(cursor, userId) as
      | { user_turn: string | null; recipe_json: string | null; parent_turn_id: string | null }
      | undefined;
    if (!turn) break;

    if (turn.user_turn && turn.recipe_json) {
      chain.push({ userTurn: turn.user_turn, recipeJson: turn.recipe_json });
    }
    cursor = turn.parent_turn_id;
  }

  return chain.reverse();
}

export interface TurnCompletion extends CallUsage {
  recipe: Recipe;
  verification: Verification;
  /** 1 normally, 2 when the repair loop ran. */
  attempts: number;
  /** Did the first attempt pass? The number the repair loop is judged on. */
  firstPassOk: boolean;
  /** The first attempt's full verdict — the only record of what repair fixed. */
  firstPassVerification: Verification;
}

export function completeTurn(turnId: string, result: TurnCompletion): void {
  db.prepare(
    `UPDATE turns SET
       recipe_json = ?, recipe_title = ?, verification_json = ?,
       verification_ok = ?, violation_count = ?,
       model = ?, reasoning_effort = ?, input_tokens = ?, output_tokens = ?,
       cache_read_tokens = ?, cache_write_tokens = ?, cache_status = ?,
       cost_usd = ?, latency_ms = ?, attempts = ?,
       first_pass_ok = ?, first_pass_verification_json = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(result.recipe),
    result.recipe.title,
    JSON.stringify(result.verification),
    result.verification.ok ? 1 : 0,
    result.verification.violations.length,
    result.model,
    result.effort,
    result.inputTokens,
    result.outputTokens,
    result.cacheReadTokens,
    result.cacheWriteTokens,
    result.cacheStatus,
    result.costUsd,
    result.latencyMs,
    result.attempts,
    result.firstPassOk ? 1 : 0,
    JSON.stringify(result.firstPassVerification),
    turnId,
  );
}

/**
 * Record a failed turn — with its cost, when the call got far enough to have
 * one.
 *
 * A refusal, a truncation or an unparseable response is still a billed call.
 * Logging only the error code meant the failures were the one category of turn
 * with no spend recorded against them, so `/api/stats` under-reported the true
 * bill and the most diagnostic turns were the least observable. `usage` is
 * absent only when the stream never completed at all — a network error or a
 * client abort — where nothing was reported to bill.
 */
export function failTurn(turnId: string, error: ErrorInfo, usage?: CallUsage): void {
  const code = error.code;
  if (!usage) {
    db.prepare(
      `UPDATE turns SET error_code = ?, error_message = ?, error_retryable = ? WHERE id = ?`,
    ).run(code, error.message, error.retryable ? 1 : 0, turnId);
    return;
  }

  db.prepare(
    `UPDATE turns SET
       error_code = ?, error_message = ?, error_retryable = ?,
       model = ?, reasoning_effort = ?, input_tokens = ?, output_tokens = ?,
       cache_read_tokens = ?, cache_write_tokens = ?, cache_status = ?,
       cost_usd = ?, latency_ms = ?
     WHERE id = ?`,
  ).run(
    code,
    error.message,
    error.retryable ? 1 : 0,
    usage.model,
    usage.effort,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.cacheStatus,
    usage.costUsd,
    usage.latencyMs,
    turnId,
  );
}

export function recordFeedback(
  turnId: string,
  userId: string,
  patch: { rating?: "up" | "down" | null; cooked?: boolean | null; note?: string | null },
): boolean {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.rating !== undefined) {
    sets.push("rating = ?");
    values.push(patch.rating);
  }
  if (patch.cooked !== undefined) {
    sets.push("cooked = ?");
    values.push(patch.cooked === null ? null : patch.cooked ? 1 : 0);
  }
  if (patch.note !== undefined) {
    sets.push("note = ?");
    values.push(patch.note);
  }
  if (sets.length === 0) return false;

  // Scoped by user_id so one user can't write feedback onto another's turn.
  const info = db
    .prepare(`UPDATE turns SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
    .run(...values, turnId, userId);
  return info.changes > 0;
}
