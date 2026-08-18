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

Measured across all three cache states on Opus (prefix 3,472 tokens, user turn
155). **Input-side cost**: `NONE` $0.01814 → `MISS` $0.02248 (24% *worse*) →
`HIT` $0.00251 (86% less). Total turn cost `MISS` $0.0778 → `HIT` $0.0587.

Three things this measurement taught, all worth preserving:

1. **Caching reclassifies tokens, it doesn't reduce them.** `input_tokens +
   cache_read + cache_write` is conserved at 3,627 in every state.
2. **A miss costs 24% more than not caching**, so break-even is a **~22% hit
   rate**. Caching is a bet on locality, not a free win.
3. **Compare input-side cost, never the total.** Output is ~96% of a warm turn
   and swings 21% run to run. An earlier version of this note claimed 45% cost
   and 32% latency savings — both were output-length variance misattributed to
   caching. No latency win was reproducible (28.1s cold vs 28.5s warm).

**Model choice is config, not code.** `RECIPE_MODEL` and `RECIPE_EFFORT` are env
vars. Default is **`claude-sonnet-5` at `medium`**, changed from Opus on eval
evidence rather than on price alone. Effort is a *separate* cost axis from model
choice; sweep it before downgrading the tier.

The three-arm result that justified the switch (12 fixtures × 3, same prompt,
same fixtures, byte-identical verifier):

| arm | first pass | final | $/passing recipe | avg | max |
|---|---|---|---|---|---|
| sonnet + repair | 29/36 | **36/36** | **$0.0463** | 26.1s | 46.1s |
| sonnet, no repair | 26/36 | 26/36 | $0.0521 | 23.5s | 51.5s |
| opus, no repair | 36/36 | 36/36 | $0.0561 | 26.1s | 38.6s |

**The repair loop is what made the downgrade safe**, and the ordering matters:
bare Sonnet was cheaper per *call* but more expensive per *passing recipe*, so
switching on price alone would have bought worse output for more money. Opus
still wins on tail latency (38.6s vs 46.1s), because repair fires on ~19% of
Sonnet requests and roughly doubles those.

**Verification is a controller, not a reporter.** `llm/verified.ts` feeds the
verifier's findings back to the model and retries **once**, bounded — each
attempt is real money and ~25s of someone's evening, and a defect that survives
a precise itemised description won't yield to a third try. The better of the two
attempts wins, so repair improves the odds without ever suppressing a verdict.

**Measure first-pass rate, never just pass rate.** With repair on, the final
pass rate approaches 100% by construction: a model that never fails and a model
rescued every time both report the same number. `first_pass_ok` and
`first_pass_verification_json` are stored on both `eval_runs` and `turns` so the
gap stays visible — and so does *what* repair fixed, since the final verdict on
a repaired run is a pass and would otherwise be the only record.

**Hash the scorer, not the commit.** Eval rows carry `prompt_hash`,
`fixture_set_hash` and `scorer_hash` — a content hash of `verify/*.ts` plus the
ingredient taxonomy. `git_sha` used to do this job and over-fired: the three-arm
table above spans two commits whose diff never touched the verifier, so the
commit key split one valid comparison into two rows. **A provenance key should
hash the thing that computes the metric.** git_sha is still recorded, for
finding the commit; it no longer gates anything. Rows predating the column fall
back to `git:<sha>` rather than being merged — over-splitting is the safe
direction to fail.

**Migrations.** `db/index.ts` uses `CREATE TABLE IF NOT EXISTS` plus a small
`addColumnIfMissing()` helper for forward-only column additions, so an existing
dev database upgrades in place. Verified against a pre-cookware DB with data —
all rows survived. Backfills live next to the column they fill and must be
idempotent; `eval_runs.repair` is derived from `first_pass_ok IS NOT NULL`
because the two shipped together. `scorer_hash` is deliberately **not**
backfilled — some of those rows were graded by the pre-taxonomy verifier, and
stamping today's hash on them would turn a gap in the record into a false claim
about it.

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
passive time**, canonical ingredient taxonomy + lemmatiser, pantry + preferences
+ cookware, turn telemetry with cost and cache status, `/api/stats` (including
first-pass and repair rates), Google OAuth via Supabase, cost/cache debug strip,
**error classification** (`llm/errors.ts`, secrets scrubbed before persisting),
**the repair loop**, and the **eval harness** — 12 fixtures, replay/re-score,
provenance hashes, three measured arms.

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
