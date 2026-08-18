import { describe, it, expect, beforeEach } from "vitest";
import { db, upsertUser } from "../db/index.js";
import { budgetFor, globalBudget, inFlight, reserve, __resetLeases } from "./budget.js";
import { decide } from "./middleware.js";

/**
 * These run against a real SQLite file, not a mock.
 *
 * The cap's whole job is to read spend that survived a restart, so mocking the
 * database would test everything except the property that matters. vitest.config
 * points DATABASE_PATH at a throwaway file — see test/global-setup.ts.
 *
 * Limits come from that same config: 3 req/min, 2 concurrent, $1/user/day,
 * $5/day globally, $0.06 reserved per in-flight call.
 */

let seq = 0;
/** A fresh user per test — `decide` keeps rate-limit state in module scope. */
function newUser(): string {
  seq += 1;
  const id = `test-user-${seq}`;
  upsertUser(id, `${id}@test`, id);
  return id;
}

/** Record a billed turn. `agoHours` places it in the rolling window. */
function spend(userId: string, costUsd: number, agoHours = 0): void {
  db.prepare(
    `INSERT INTO turns (id, user_id, craving, servings, max_minutes, effort,
                        will_shop, pantry_json, cost_usd, created_at)
     VALUES (?, ?, 'test', 2, 30, 'moderate', 0, '[]', ?,
             datetime('now', ?))`,
  ).run(`turn-${userId}-${Math.random()}`, userId, costUsd, `-${agoHours} hours`);
}

beforeEach(() => {
  __resetLeases();
  db.exec("DELETE FROM turns; DELETE FROM limit_events;");
});

describe("budgetFor", () => {
  it("counts recorded spend against the cap", () => {
    const u = newUser();
    spend(u, 0.25);
    spend(u, 0.25);

    const b = budgetFor(u);
    expect(b.spentUsd).toBeCloseTo(0.5);
    expect(b.remainingUsd).toBeCloseTo(0.5);
  });

  it("ignores spend outside the rolling 24h window", () => {
    const u = newUser();
    spend(u, 0.9, 25); // yesterday, just outside
    expect(budgetFor(u).spentUsd).toBe(0);
    expect(budgetFor(u).remainingUsd).toBeCloseTo(1);
  });

  it("counts FAILED turns, which are billed like any other", () => {
    // A cap that ignored failures would let a client loop on a request that
    // reliably truncates and burn the whole budget for free.
    const u = newUser();
    db.prepare(
      `INSERT INTO turns (id, user_id, craving, servings, max_minutes, effort,
                          will_shop, pantry_json, cost_usd, error_code)
       VALUES ('failed-1', ?, 'x', 2, 30, 'moderate', 0, '[]', 0.4, 'truncated')`,
    ).run(u);
    expect(budgetFor(u).spentUsd).toBeCloseTo(0.4);
  });

  it("one user's spend does not touch another's budget", () => {
    const a = newUser();
    const b = newUser();
    spend(a, 0.9);
    expect(budgetFor(a).remainingUsd).toBeCloseTo(0.1);
    expect(budgetFor(b).remainingUsd).toBeCloseTo(1);
  });
});

describe("reservations", () => {
  it("count against remaining before the call is billed", () => {
    // The race this closes: cost is unknown for ~26 seconds, so a cap reading
    // only recorded spend is blind for the whole duration of every request.
    const u = newUser();
    spend(u, 0.9);
    expect(budgetFor(u).remainingUsd).toBeCloseTo(0.1);

    reserve(u);
    expect(budgetFor(u).reservedUsd).toBeCloseTo(0.06);
    expect(budgetFor(u).remainingUsd).toBeCloseTo(0.04);

    reserve(u);
    expect(budgetFor(u).remainingUsd).toBe(0); // clamped, not negative
  });

  it("release frees the reservation", () => {
    const u = newUser();
    const release = reserve(u);
    expect(inFlight(u)).toBe(1);
    release();
    expect(inFlight(u)).toBe(0);
    expect(budgetFor(u).reservedUsd).toBe(0);
  });

  it("release is idempotent and frees only its own lease", () => {
    // A `finally` that runs after an error path already released is a normal
    // shape; a double release must not free somebody else's claim.
    const u = newUser();
    const first = reserve(u);
    reserve(u);
    first();
    first();
    first();
    expect(inFlight(u)).toBe(1);
  });

  it("leases expire, so a crashed request cannot hold budget forever", () => {
    const u = newUser();
    const now = Date.now();
    reserve(u, now); // never released — the process died mid-stream
    expect(inFlight(u, now)).toBe(1);
    expect(inFlight(u, now + 181_000)).toBe(0);
  });
});

describe("decide — the admission policy", () => {
  it("allows a request with budget and no traffic", () => {
    expect(decide(newUser())).toBeNull();
  });

  it("refuses over the concurrency limit", () => {
    const u = newUser();
    reserve(u);
    reserve(u);
    expect(decide(u)?.reason).toBe("concurrency");
  });

  it("refuses over the rate limit", () => {
    const u = newUser();
    const now = Date.now();
    expect(decide(u, now)).toBeNull();
    expect(decide(u, now + 1)).toBeNull();
    expect(decide(u, now + 2)).toBeNull();
    const denied = decide(u, now + 3);
    expect(denied?.reason).toBe("rate_limit");
    expect(denied?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("refuses over the per-user daily cap", () => {
    const u = newUser();
    spend(u, 1.0);
    expect(decide(u)?.reason).toBe("user_daily_cap");
  });

  it("refuses over the global cap even when the user has budget left", () => {
    // Per-user caps bound fairness, not the bill: (users x cap) is unbounded.
    const victim = newUser();
    for (let i = 0; i < 6; i += 1) spend(newUser(), 1.0);
    expect(budgetFor(victim).remainingUsd).toBeCloseTo(1);
    expect(globalBudget().spentUsd).toBeCloseTo(6);
    expect(decide(victim)?.reason).toBe("global_daily_cap");
  });

  it("checks cheapest first: a concurrency refusal never consumes rate budget", () => {
    // Ordering matters under exactly the burst this exists to survive — a
    // refusal must not itself cost a database query or an allowance.
    const u = newUser();
    const now = Date.now();
    reserve(u);
    reserve(u);
    for (let i = 0; i < 10; i += 1) expect(decide(u, now + i)?.reason).toBe("concurrency");

    __resetLeases();
    // All three per-minute allowances are still intact.
    expect(decide(u, now + 20)).toBeNull();
    expect(decide(u, now + 21)).toBeNull();
    expect(decide(u, now + 22)).toBeNull();
    expect(decide(u, now + 23)?.reason).toBe("rate_limit");
  });

  it("the refusal message names the limit without leaking another user's data", () => {
    const u = newUser();
    spend(u, 1.0);
    const r = decide(u);
    expect(r?.message).toMatch(/today/i);
    expect(r?.detail).toContain("$1.0000");
  });
});
