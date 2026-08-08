import { randomUUID } from "node:crypto";
import type { CookRequest, Recipe, Verification } from "@cookable/shared";
import { db } from "../db/index.js";
import type { CacheStatus } from "../llm/models.js";

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

export function openTurn(userId: string, request: CookRequest): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO turns
       (id, user_id, craving, servings, max_minutes, effort, will_shop, pantry_json, cookware_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
  return id;
}

export interface TurnCompletion {
  recipe: Recipe;
  verification: Verification;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheStatus: CacheStatus;
  costUsd: number;
  latencyMs: number;
}

export function completeTurn(turnId: string, result: TurnCompletion): void {
  db.prepare(
    `UPDATE turns SET
       recipe_json = ?, recipe_title = ?, verification_json = ?,
       verification_ok = ?, violation_count = ?,
       model = ?, input_tokens = ?, output_tokens = ?,
       cache_read_tokens = ?, cache_write_tokens = ?, cache_status = ?,
       cost_usd = ?, latency_ms = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(result.recipe),
    result.recipe.title,
    JSON.stringify(result.verification),
    result.verification.ok ? 1 : 0,
    result.verification.violations.length,
    result.model,
    result.inputTokens,
    result.outputTokens,
    result.cacheReadTokens,
    result.cacheWriteTokens,
    result.cacheStatus,
    result.costUsd,
    result.latencyMs,
    turnId,
  );
}

export function failTurn(turnId: string, code: string): void {
  db.prepare(`UPDATE turns SET error_code = ? WHERE id = ?`).run(code, turnId);
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
