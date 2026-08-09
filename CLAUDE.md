# Cookmate — working context

Notes for anyone (human or Claude) picking this repo up cold. Read this before
changing anything; it records *why* things are the way they are, which the code
alone doesn't tell you.

---

## What this is and who it's for

An AI recipe app that suggests meals you can **actually cook right now** — with
the ingredients you have, the appliances you own, and the time you've got.

It is also a portfolio project for AI-engineering interviews, which shapes some
decisions: readable architecture is worth more here than micro-optimisation, and
several choices exist specifically to be explainable out loud.

The one-line pitch: *most AI recipe apps promise in marketing copy; this one
promises in code, and has a test suite proving it.*

---

## The central thesis — read this first

**Every promise the app makes must be machine-checkable.**

Recipe generation is a grounding problem. The model is given evidence (your
pantry, your cookware, your time budget) and must not exceed it. So after
generation, [`apps/api/src/verify/constraints.ts`](apps/api/src/verify/constraints.ts)
runs a **deterministic verifier** in plain TypeScript with no model call.

Two rules follow from this, and they are the most important rules in the repo:

1. **Never ask a model to check something a computer can check exactly.**
   Set membership and arithmetic are decidable, so they belong in code with unit
   tests. Asking the model "did you follow the rules?" invites the system that
   made the error to grade its own error.
2. **Never trust the model's own grounding claim.** The model tags each
   ingredient with a `source` (`pantry` / `staple` / `shopping`). The verifier
   **discards that and recomputes it.** If Claude says an ingredient is in your
   pantry and it isn't, that gets caught and shown to the user.

When adding a feature, ask: *can I verify this deterministically?* If yes, it
fits the thesis. If no, think harder before shipping it.

A worked example of the payoff: the constraint verifier caught a genuine bug on
the very first live generation — see "Bugs already fixed" below.

---

## Architecture

```
Browser (React + Vite)
   │  POST /api/chat/stream  (SSE)
   ▼
Hono API (Node)
   1. load pantry + prefs + cookware from SQLite
   2. openTurn()                      → telemetry row opened
   3. stream from Claude              → delta, delta, delta …
      (structured output via Zod)
   4. RecipeSchema.parse()            → recipe
   5. verifyRecipe()   ← DETERMINISTIC → verification
   6. completeTurn()                  → done (cost, cache, latency)
```

Generation and verification are **deliberately two phases**, and the UI mirrors
it: the card fills in as tokens arrive, then the badge resolves from "Checking
against your kitchen…" to a verdict. Don't collapse this into one step — that
pause is the product making its claim.

### Why all-TypeScript (the interview answer)

The recipe schema is consumed at **three boundaries** and TS lets it exist once:

```ts
zodOutputFormat(RecipeSchema)               // model boundary  — constrains generation
RecipeSchema.parse(JSON.parse(text))        // server boundary — validates before use
type Recipe = z.infer<typeof RecipeSchema>  // render boundary — types the React card
```

A Python backend + React frontend would define this in Pydantic and then
hand-maintain or codegen the TS types, reintroducing drift on the exact artifact
whose fidelity *is* the product claim.

This pays off concretely: adding `equipment` and `handsOff` to `StepSchema`
produced compile errors in every consumer that needed updating, including two
test fixtures. Nothing silently drifted.

---

## Key files

| Path | Why it matters |
|---|---|
| `packages/shared/src/recipe.ts` | **Start here.** The schema everything hangs off. |
| `packages/shared/src/constraints.ts` | `CookRequest` (the evidence) + `Verification` (the verdict) |
| `packages/shared/src/events.ts` | SSE wire protocol, discriminated union on `type` |
| `apps/api/src/verify/constraints.ts` | **The product.** Deterministic checks. |
| `apps/api/src/verify/constraints.test.ts` | 23 tests. Add one whenever you add a constraint. |
| `apps/api/src/llm/models.ts` | Model registry + cost accounting |
| `apps/api/src/llm/prompts.ts` | Frozen system prompt (the cached prefix) |
| `apps/api/src/llm/generate.ts` | Streaming + structured output |
| `apps/api/src/telemetry/turns.ts` | Turn logging — built before the UI, on purpose |

---

## Conventions and gotchas

**Server-owned state.** Pantry, dislikes, dietary and cookware are the evidence
recipes are grounded against, so the client **cannot supply or override them**.
They're `.omit()`ed from the inbound schema in `routes/chat.ts`; because the base
schema is `.strict()`, a client that tries gets a 400 rather than being silently
ignored. Read them from the DB, always.

**Zod trap — `.partial()` does not strip `.default()`.** A field marked optional
via `.partial()` still parses to its default (`[]`), *not* `undefined`, which
silently defeats a `?? readFromDatabase()` fallback. This caused a real bug (see
below). Prefer `.omit()` when the client shouldn't send a field at all.

**Closed vocabularies beat fuzzy matching.** `equipment` is a Zod enum, so
structured outputs make it impossible for the model to emit an unknown
appliance — verification becomes exact set membership with no normalisation.
Compare with ingredient matching, which is free text and needs
`normalise()` + head-noun rules + a product-qualifier guard, and still has known
gaps. **When you can constrain the vocabulary at the schema, do it.**

**Derive, don't ask.** `activeMinutes` / `passiveMinutes` are computed by the
verifier from the steps rather than requested from the model. Exact arithmetic
should never be delegated — asking for it just creates something else to verify.

**Prompt caching is prefix-matched.** `SYSTEM_PROMPT` must stay **frozen** — no
dates, no user IDs, no request data interpolated in. Everything volatile goes in
`buildUserTurn()`, which renders after the cache breakpoint. One `new Date()` in
the system prompt silently destroys caching with no error.

Measured on a real pair of calls: cache MISS → HIT dropped cost from **$0.0591
to $0.0324 (45%)** and latency from **20.3s to 13.8s**.

**Model choice is config, not code.** `RECIPE_MODEL` and `RECIPE_EFFORT` are env
vars. Default is `claude-opus-5` at `medium`. Switching to `claude-sonnet-5` is
~40% cheaper — but **measure on an eval set before switching**, don't assume.
Effort is a *separate* cost axis from model choice; sweep it before downgrading
the tier.

**Migrations.** `db/index.ts` uses `CREATE TABLE IF NOT EXISTS` plus a small
`addColumnIfMissing()` helper for forward-only column additions, so an existing
dev database upgrades in place. Verified against a pre-cookware DB with data —
all rows survived.

---

## Bugs already fixed (don't reintroduce)

**The pantry never reached the verifier** (commit `c15e40b`). The chat route
accepted an "optional" pantry via `.partial()`, which parsed to `[]` instead of
`undefined`, defeating the `?? getPantry()` fallback. The web form compounded it
by explicitly sending `pantry: []`. Every recipe was generated against an empty
pantry. Caught by the verifier itself on the first live generation — it flagged
"white rice" as needing shopping when rice was right there in the pantry.
Regression tests cover both halves.

---

## Current state

**Done:** streaming chat, structured recipe output, deterministic verification
(ingredients, time, dislikes, dietary, servings, **cookware**), **active vs
passive time**, pantry + preferences + cookware, turn telemetry with cost and
cache status, `/api/stats`, Google OAuth via Supabase, cost/cache debug strip.

**Next up, in the order they were prioritised:**

1. **Repeat avoidance** — every turn's title and cuisine is already logged.
   Inject the last ~10 into the prompt as a constraint ("they've had stir-fry
   twice this week"). Nearly free, and it makes "learns you" true rather than a
   landing-page claim.
2. **Use-it-first** — optional expiry date per pantry item, weight recipes that
   consume what's about to go off.
3. **Pantry photo → ingredients** — vision, on the Haiku tier (cheap, high
   volume, structured extraction, no judgment).
4. **Weekly plan with a shared pantry** — generate three dinners that
   *collectively* fit one pantry. Genuine constraint satisfaction over a shared
   resource; no consumer app does this. This is the standout feature and the
   place where escalating to Opus 5 at high effort actually earns its cost.
5. **MCP server** — expose `get_pantry` / `suggest_recipe` /
   `add_to_shopping_list`. Can import these same Zod schemas.
6. **Eval harness** — fixed set of (pantry, cookware, constraints) cases,
   asserting the verifier passes. Then the model/effort sweep has real numbers.

Deliberately **not** doing: real-time supermarket stock checking (no reliable
API; substitutions + a shopping list serve the same need), quantity-aware pantry
(UI friction outweighs the gain), skill-floor checking (too fuzzy to verify).

---

## Running it

```bash
pnpm install
cp .env.example .env                    # add ANTHROPIC_API_KEY
cp apps/web/.env.example apps/web/.env  # optional, for Google OAuth
pnpm dev          # api :8787, web :5173
pnpm -r typecheck
cd apps/api && pnpm vitest run
```

`DEV_ALLOW_ANONYMOUS=1` bypasses auth so the whole UI is buildable before the
OAuth consent screen exists.

**Live generations cost real money.** Prefer unit tests and the boot smoke test;
only make live calls when you're specifically validating model behaviour.

### Environment notes

- Node 24 on Intel macOS: `better-sqlite3` has no prebuilt binary and compiles
  from source (~85s on first install). If that ever breaks, Node 24 ships a
  built-in `node:sqlite` that works as a drop-in escape hatch.
- The Anthropic SDK must be **≥ 0.116** (`output_config`, `helpers/zod`), which
  in turn requires **Zod v4**. Don't downgrade either.
