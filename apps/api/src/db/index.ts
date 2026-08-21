import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EquipmentSchema, type Equipment } from "@cookmate/shared";
import { config } from "../config.js";

/**
 * SQLite, deliberately.
 *
 * At one-to-a-few users this is a file on disk with zero infrastructure, and
 * the telemetry queries the /stats page needs are ordinary SQL. Access goes
 * through this module only, so swapping to Postgres later is one file.
 */

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });

export const db: Database.Database = new Database(config.DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,          -- Supabase auth 'sub' claim
  email        TEXT,
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Free-text pantry lines, one row per item.
CREATE TABLE IF NOT EXISTS pantry_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS preferences (
  user_id  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dislikes TEXT NOT NULL DEFAULT '[]',   -- JSON array
  dietary  TEXT NOT NULL DEFAULT '[]',   -- JSON array
  cookware TEXT NOT NULL DEFAULT '[]'    -- JSON array of Equipment enum values
);

-- One row per recipe generation. This table IS the answer to
-- "how do you know they still use it".
CREATE TABLE IF NOT EXISTS turns (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),

  -- what they asked for
  craving            TEXT NOT NULL,
  servings           INTEGER NOT NULL,
  max_minutes        INTEGER NOT NULL,
  effort             TEXT NOT NULL,
  will_shop          INTEGER NOT NULL,
  pantry_json        TEXT NOT NULL,

  -- what we produced
  recipe_json        TEXT,
  recipe_title       TEXT,
  verification_json  TEXT,
  verification_ok    INTEGER,
  violation_count    INTEGER,

  -- what it cost us
  model              TEXT,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cache_status       TEXT,
  cost_usd           REAL,
  latency_ms         INTEGER,

  -- what happened afterwards (the signal that actually matters)
  rating             TEXT,      -- 'up' | 'down' | NULL
  cooked             INTEGER,   -- 1 | 0 | NULL
  note               TEXT,

  error_code         TEXT
);

-- The shopping list. The verifier already computes what a recipe would need
-- you to buy; this is where that lands when someone decides to act on it.
CREATE TABLE IF NOT EXISTS shopping_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- Which recipe put it there, so an item can be traced back to a reason.
  from_turn  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_turns_user_created ON turns(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_created ON turns(created_at DESC);
`);

/**
 * Tiny forward-only migration helper. `CREATE TABLE IF NOT EXISTS` above only
 * covers fresh databases — an existing dev database predates the cookware
 * column, so add it in place rather than making people delete their data.
 */
export function addColumnIfMissing(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("preferences", "cookware", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("turns", "cookware_json", "TEXT");
// The model's reasoning budget (low…max). Distinct from the `effort` column
// above, which is the *cook's* effort preference (minimal | moderate | project).
// Without this, a model/effort sweep can't attribute a result to its condition.
addColumnIfMissing("turns", "reasoning_effort", "TEXT");
// Why a turn failed, not just that it did. See llm/errors.ts.
addColumnIfMissing("turns", "error_message", "TEXT");
addColumnIfMissing("turns", "error_retryable", "INTEGER");
// Prompt provenance in product telemetry, matching what eval_runs already
// records — otherwise a quality change can't be attributed to a prompt edit.
addColumnIfMissing("turns", "prompt_hash", "TEXT");
// 2 when the repair loop ran. Lets /api/stats separate "right first time" from
// "rescued", which a single pass rate cannot.
addColumnIfMissing("turns", "attempts", "INTEGER");
// The first attempt's verdict, kept even when repair fixed it. `verification_json`
// holds the FINAL verdict, so on a repaired turn it records a pass and the defect
// that triggered the repair is gone. These two columns are where a production
// failure mode stays visible after the loop has quietly cleaned it up.
addColumnIfMissing("turns", "first_pass_ok", "INTEGER");
addColumnIfMissing("turns", "first_pass_verification_json", "TEXT");
// The user turn exactly as it was rendered into the prompt.
//
// Without it, "the model ignored the pantry" and "the pantry never reached the
// model" are indistinguishable after the fact — and the second one is a bug
// this project has actually shipped. pantry_json records what we MEANT to send;
// this records what we DID send, and the gap between those two is where that
// class of bug lives.
addColumnIfMissing("turns", "user_turn", "TEXT");
// The turn this one is a follow-up to. Walking the chain rebuilds the
// conversation history; null means this is the first turn.
addColumnIfMissing("turns", "parent_turn_id", "TEXT");

export function upsertUser(id: string, email: string | null, displayName: string | null): void {
  db.prepare(
    `INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email = COALESCE(excluded.email, users.email),
       display_name = COALESCE(excluded.display_name, users.display_name)`,
  ).run(id, email, displayName);
}

export function getPantry(userId: string): string[] {
  const rows = db
    .prepare(`SELECT name FROM pantry_items WHERE user_id = ? ORDER BY name`)
    .all(userId) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export function setPantry(userId: string, items: string[]): void {
  const clear = db.prepare(`DELETE FROM pantry_items WHERE user_id = ?`);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO pantry_items (user_id, name) VALUES (?, ?)`,
  );
  db.transaction(() => {
    clear.run(userId);
    for (const raw of items) {
      const name = raw.trim().toLowerCase();
      if (name) insert.run(userId, name);
    }
  })();
}

export interface ShoppingItem {
  name: string;
  fromTurn: string | null;
  addedAt: string;
}

export function getShoppingList(userId: string): ShoppingItem[] {
  const rows = db
    .prepare(
      `SELECT name, from_turn, created_at FROM shopping_items
       WHERE user_id = ? ORDER BY created_at, name`,
    )
    .all(userId) as Array<{ name: string; from_turn: string | null; created_at: string }>;
  return rows.map((r) => ({ name: r.name, fromTurn: r.from_turn, addedAt: r.created_at }));
}

/**
 * Add items, ignoring ones already on the list.
 *
 * `INSERT OR IGNORE` against the UNIQUE constraint is what makes this
 * idempotent, which matters more here than it looks: this is reachable from an
 * MCP tool, and an agent that retries a call must not end up with the same
 * item three times. Returns the names actually added so the caller can say
 * what changed rather than what it asked for.
 */
export function addToShoppingList(
  userId: string,
  items: string[],
  fromTurn?: string | null,
): string[] {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO shopping_items (user_id, name, from_turn) VALUES (?, ?, ?)`,
  );
  const added: string[] = [];
  db.transaction(() => {
    for (const raw of items) {
      const name = raw.trim().toLowerCase();
      if (!name) continue;
      if (insert.run(userId, name, fromTurn ?? null).changes > 0) added.push(name);
    }
  })();
  return added;
}

export function removeFromShoppingList(userId: string, items: string[]): number {
  const del = db.prepare(`DELETE FROM shopping_items WHERE user_id = ? AND name = ?`);
  let removed = 0;
  db.transaction(() => {
    for (const raw of items) {
      removed += del.run(userId, raw.trim().toLowerCase()).changes;
    }
  })();
  return removed;
}

export interface Preferences {
  dislikes: string[];
  dietary: string[];
  cookware: Equipment[];
}

/**
 * Drop cookware values that are no longer in the Equipment enum.
 *
 * The enum is validated on the way IN, so this only catches rows written before
 * a value was removed from the vocabulary — but the failure it prevents is
 * nasty. An unknown value can't render as a button (the UI maps over
 * APPLIANCES), so it sits invisibly in React state, gets sent back on every
 * save, and is rejected by the enum on the way in. The user sees "invalid
 * option" for something they cannot see, let alone untick.
 *
 * Filtering on read makes it self-healing: the bad value never reaches the
 * client, so the next save persists the cleaned list. The alternative — a
 * one-off migration — fixes today's stale value and not the next one.
 */
function readCookware(raw: string): Equipment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is Equipment => EquipmentSchema.safeParse(item).success);
}

export function getPreferences(userId: string): Preferences {
  const row = db
    .prepare(`SELECT dislikes, dietary, cookware FROM preferences WHERE user_id = ?`)
    .get(userId) as { dislikes: string; dietary: string; cookware: string } | undefined;
  if (!row) return { dislikes: [], dietary: [], cookware: [] };
  return {
    dislikes: JSON.parse(row.dislikes) as string[],
    dietary: JSON.parse(row.dietary) as string[],
    cookware: readCookware(row.cookware),
  };
}

export function setPreferences(userId: string, prefs: Preferences): void {
  db.prepare(
    `INSERT INTO preferences (user_id, dislikes, dietary, cookware) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       dislikes = excluded.dislikes,
       dietary  = excluded.dietary,
       cookware = excluded.cookware`,
  ).run(
    userId,
    JSON.stringify(prefs.dislikes),
    JSON.stringify(prefs.dietary),
    JSON.stringify(prefs.cookware),
  );
}
