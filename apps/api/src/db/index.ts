import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Equipment } from "@cookable/shared";
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

CREATE INDEX IF NOT EXISTS idx_turns_user_created ON turns(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_created ON turns(created_at DESC);
`);

/**
 * Tiny forward-only migration helper. `CREATE TABLE IF NOT EXISTS` above only
 * covers fresh databases — an existing dev database predates the cookware
 * column, so add it in place rather than making people delete their data.
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("preferences", "cookware", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("turns", "cookware_json", "TEXT");

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

export interface Preferences {
  dislikes: string[];
  dietary: string[];
  cookware: Equipment[];
}

export function getPreferences(userId: string): Preferences {
  const row = db
    .prepare(`SELECT dislikes, dietary, cookware FROM preferences WHERE user_id = ?`)
    .get(userId) as { dislikes: string; dietary: string; cookware: string } | undefined;
  if (!row) return { dislikes: [], dietary: [], cookware: [] };
  return {
    dislikes: JSON.parse(row.dislikes) as string[],
    dietary: JSON.parse(row.dietary) as string[],
    cookware: JSON.parse(row.cookware) as Equipment[],
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
