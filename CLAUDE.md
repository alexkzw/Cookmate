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
| `apps/api/src/limits/` | Admission control: rate limit, concurrency, cost caps |
| `apps/api/src/evals/judge.ts` | The quality judge + calibration + length-bias probe |
| `apps/api/src/mcp/server.ts` | MCP server — a second entry point, not a second service |
| `apps/api/src/limits/policy.ts` | The admission policy, transport-agnostic |

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

**Display name and match key are different fields.** `IngredientSchema` carries
both `name` ("ripe tomatoes, diced" — prose, for the card) and `matchTerm`
("tomato" — canonical, for the verifier). They used to be one field, which cost
twice: the card read like a database row, and matching was still free text. The
verifier resolves `matchTerm` and *reports* `name`, and falls back to `name` when
`matchTerm` is absent so recipes stored before the split stay replayable.

**Follow-ups are re-generations, not chat.** `POST /api/chat/stream` takes an
optional `followUpTo`; the server walks `parent_turn_id` back through `turns`,
replays the stored user turns and recipe JSON as conversation history, and
returns a **fully verified Recipe** — so every claim the verifier makes is as
true on turn five as on turn one. History is bounded at 6 turns and scoped by
`user_id` (an unguessable id is not an authorisation model).

**Multi-turn is the best case for prompt caching, not a tax on it.** A
conversation only ever *appends*, so history is a growing stable prefix. Two
breakpoints: the frozen system block, and the last block of the newest turn.
Single-turn requests get no second breakpoint at all — there is no prior
conversation to read, so a marker would buy a write premium and nothing else.

**TTLs must be non-increasing in render order** (`tools` → `system` →
`messages`). The API rejects a 1h block that follows a 5m one, so 5m on the
system block plus 1h on the tail — the arrangement that first shipped — is a
400, and it only fires on the *second* follow-up because that is the first
request carrying two breakpoints. The tail is the breakpoint that needs the
longer life (the gap there is a person reading a recipe), so the system block is
promoted to match rather than the tail cut down. Both are now **1h**, defined
once as `CACHE_TTL` in `llm/generate.ts`. The cost is honest: a 1h write bills
2× base against 1.25× for 5m, moving single-turn break-even from ~2 requests to
~3, in exchange for a shared prefix that survives an hour of silence instead of
five minutes. `buildPromptBlocks` is exported so the layout is asserted in unit
tests — the API enforcing this at request time is the most expensive place to
find out.

**`turns.user_turn` records the prompt as rendered.** `pantry_json` records what
we *meant* to send; `user_turn` records what we *did*. Without both, "the model
ignored the pantry" and "the pantry never reached the model" are
indistinguishable after the fact — and the second one is a bug this project has
actually shipped.

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

**Admission control: two mechanisms, because neither covers the other.** A
rate limit bounds *burst* but not money — cost per turn is not constant, since
the repair loop roughly doubles it. A cost cap bounds *spend* but not burst —
concurrent requests all read the same under-cap total before any is billed. Both
live in `limits/`, run after `requireAuth` (every limit is per-user) and before
any model call. Checks are ordered cheapest first: concurrency and rate are map
lookups, the caps are SQL, and a request the in-memory counters already refused
should never reach the database.

**Rate limiting is in memory; the cost cap is not.** Burst is a per-process
concern, so a window in SQLite would add a write to every request's hot path to
defend against a failure a single-process deployment doesn't have. Money spent
must survive a restart, or a deploy loop becomes a way to reset the budget. The
honest limit: N processes each enforce their own window, so the effective rate
is N × limit — at which point the window moves to Redis and its interface
doesn't change.

**The cost of a call is unknown until ~26s after it starts**, so a cap reading
only recorded spend is blind for the whole duration of every request it governs.
`limits/budget.ts` reserves a pessimistic estimate up front and releases it when
the true cost lands. Reservations are **leases, not locks** — they expire, so a
process that dies mid-stream can't permanently consume someone's budget. The
release happens in the *route's* `finally`, not the middleware's: `next()`
returns when the stream **starts**, so releasing there would free the budget
~26 seconds early and reopen the exact hole the reservation closes.

**To prove a threshold, lower the limit — don't raise the load.** At ~$0.05 and
26s a request, demonstrating a 10/min limit by generating traffic costs money and
takes a minute. Booting with `RATE_LIMIT_PER_MINUTE=1` proves the same policy in
two requests, and the refused one costs nothing because it never reaches the
model. `pnpm measure:limits` does this; seeding a scratch DB with spend proves
the cost cap for $0 as well. The inversion generalises: a threshold is cheapest
to test from the side you control.

**The quality judge is the one model-graded thing here, and that's deliberate.**
The verifier can prove a recipe is *legal*; it cannot say whether it's *good*.
Boiled pasta with salt passes all seven checks. `evals/judge.ts` scores appeal,
technique and clarity on Haiku (different tier from the generator), blind to
which arm produced the recipe, with a pinned model id — an unpinned judge
silently redefines the metric. It reads stored `recipe_json`, so it costs
pennies and asks the model to generate nothing.

**A judge is worthless until it is calibrated, and length bias is testable.**
`pnpm eval --label` records human scores *blind* (the judge's score is never
shown — seeing it first measures your suggestibility, not its accuracy), and
`--judge-report` prints mean absolute error plus the judge-minus-human bias,
which separates "systematically generous" from "uncorrelated". The same report
correlates score against `output_tokens`: the best-documented judge failure is
mistaking verbosity for quality, and it's the easiest to test for if you kept
the token counts. Neither number is proof — longer recipes may genuinely be
better — but a big gap is where to go looking.

**MCP is the supply side.** `apps/api/src/mcp/server.ts` makes Cookmate
**callable by** an agent. It does not make Cookmate an agent — nothing in it
chooses a tool or runs a loop. It is also not a second service: same Zod
schemas, same `generateVerifiedRecipe`, same verifier, same turn log. If any of
that were reimplemented there, the argument for one TypeScript codebase would
collapse on the first drift.

**A second entry point is a second way to bypass your limits.** An MCP call
never touches Hono, so it never runs `enforceLimits` — which would have made
stdio an unmetered door onto the expensive endpoint. The fix was structural:
the policy moved to `limits/policy.ts` as a pure function and `middleware.ts`
became a thin Hono adapter, so both doors call the same `decide()` and
`reserve()`. **Keep the decision separate from the delivery; delivery mechanisms
multiply.** Turns are logged from MCP too, or `/api/stats` would quietly
under-report whatever arrived over stdio. Honest gap: the MCP server is a
separate *process*, so it runs its own in-memory rate window — the cost caps are
shared because they live in SQLite. Same trade as running two API processes.

**Pass the schema, not its `.shape`.** `registerTool`'s `inputSchema` accepts
either. `.shape` hands over the fields and **drops `.strict()`**, so an extra
`pantry` key would be silently stripped rather than rejected — the exact
"silently ignored" failure that caused the empty-pantry bug, arriving through a
new door. Caught by a smoke test that asserted the error and got a recipe.

**Identity over stdio is configuration, not a request field.** An MCP server is
a subprocess of one client acting as one person, so `MCP_USER_ID` is pinned at
boot and no tool accepts a user id. A tool that took one would let any caller
read any kitchen by asking. Writing the pantry is deliberately **not exposed**:
it is the evidence every recipe is verified against, so an agent appending to it
wouldn't raise an error — it would produce recipes that pass against a kitchen
the person doesn't have. Reads are cheap to be wrong about; writes to the
evidence are not.

**A tool response must describe its own evidence.** An MCP conversation is
long-lived and the database isn't frozen: a client that called `get_pantry` ten
minutes ago holds a stale snapshot, and without help it cannot tell "the kitchen
changed" from "the tool is lying". Claude Desktop hit exactly this — it compared
a correct recipe against a stale pantry, declared the tool unreliable, and wrote
its own unverified recipe **containing chicken for a pescatarian user**. So
`suggest_recipe` now returns `groundedIn` — the pantry, dietary and cookware it
actually used — in both the prose and the structured payload. Same principle as
the verifier reporting what it resolved rather than only whether it passed.

That incident is also the best argument for the verifier there is: an agent
discarded a *verified* answer in favour of an *unverified* one that broke a hard
dietary constraint.

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

**A provider 400 was logged as `internal_error`.** The chat route derived its
log code from `err instanceof RecipeGenerationError` while writing the properly
classified code to the database, so the console and the turn log disagreed about
the same failure and the console was the misleading one. Classify once, use it
everywhere — whatever you log is what someone greps at 2am.

**Cancelled requests were logged as provider failures.** `APIUserAbortError`
*extends* `APIError`, so an `instanceof Anthropic.APIError` branch placed first
swallowed it and every Stop press was recorded as `api_error` — inflating the
one number you'd page on. Classify most-specific-first; the abort check now sits
above the general branch, with a test.

**The pantry never reached the verifier** (commit `c15e40b`). The chat route
accepted an "optional" pantry via `.partial()`, which parsed to `[]` instead of
`undefined`, defeating the `?? getPantry()` fallback. The web form compounded it
by explicitly sending `pantry: []`. Every recipe was generated against an empty
pantry. Caught by the verifier itself on the first live generation — it flagged
"white rice" as needing shopping when rice was right there in the pantry.
Regression tests cover both halves.

---

## Current state

**Done:** streaming chat, **MCP server**, **multi-turn follow-ups**, structured recipe output, deterministic verification
(ingredients, time, dislikes, dietary, servings, **cookware**), **active vs
passive time**, canonical ingredient taxonomy + lemmatiser, pantry + preferences
+ cookware, turn telemetry with cost and cache status, `/api/stats` (including
first-pass and repair rates), Google OAuth via Supabase, cost/cache debug strip,
**error classification** (`llm/errors.ts`, secrets scrubbed before persisting),
**the repair loop**, and the **eval harness** — 12 fixtures, replay/re-score,
provenance hashes, three measured arms.

**Next up, in the order they were prioritised:**

0. **Rate limiting + per-user daily cost cap** — done, see `limits/`. Left here
   because the remaining gap is the UI: `/api/limits` is served but nothing
   renders it, so a user still learns about the cap by being refused.
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

### The MCP server

```bash
pnpm mcp          # stdio; diagnostics go to stderr because stdout IS the transport
```

To connect Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cookmate": {
      "command": "pnpm",
      "args": ["--dir", "/ABSOLUTE/PATH/TO/cookmate/apps/api", "mcp"],
      "env": { "MCP_USER_ID": "your-supabase-user-id" }
    }
  }
}
```

Five tools: `get_pantry`, `suggest_recipe`, `get_shopping_list`,
`add_to_shopping_list`, `remove_from_shopping_list`. Each carries MCP
annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) so a client can decide what needs confirming without guessing
from the name.

**Live generations cost real money.** Prefer unit tests and the boot smoke test;
only make live calls when you're specifically validating model behaviour.

### Environment notes

- Node 24 on Intel macOS: `better-sqlite3` has no prebuilt binary and compiles
  from source (~85s on first install). If that ever breaks, Node 24 ships a
  built-in `node:sqlite` that works as a drop-in escape hatch.
- The Anthropic SDK must be **≥ 0.116** (`output_config`, `helpers/zod`), which
  in turn requires **Zod v4**. Don't downgrade either.
