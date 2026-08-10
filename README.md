# Cookmate

Recipes you can actually make tonight — with the ingredients you already have, in the time you actually have.

Most AI recipe apps will cheerfully suggest a dish that needs four things you don't own and takes twice as long as you said. Cookmate's differentiator is that **every recipe is verified against your constraints before you see it**, by deterministic code rather than by asking the model whether it followed the rules.

---

## The core idea

This is a grounding problem wearing an apron.

| Grounded document QA | Cookmate |
| --- | --- |
| Answer only from retrieved passages | Recipe only from pantry, cookware + stated constraints |
| Hallucination = a fact not in the source | Hallucination = **an ingredient you don't have**, an air fryer you don't own, or 45 minutes when you said 20 |
| Verify claims against the evidence | Verify every ingredient against the pantry, every appliance against your kitchen, every minute against the budget |
| Cite the passage | Tag each ingredient `have it` / `staple` / `buy` |

What gets checked, deterministically, on every recipe:

- **Ingredients** — each one recomputed against your pantry; the model's own claim is discarded
- **Cookware** — no air fryer, no air fryer recipes. Per-step, so "transfer to the air fryer" in step 4 is caught
- **Time** — total against your budget, and step times against the stated total
- **Active vs passive** — derived, not asked for: *"40 minutes, only 8 hands-on"*
- **Dislikes and dietary needs** — absolute, garnishes included
- **Servings**

The verifier ([`apps/api/src/verify/constraints.ts`](apps/api/src/verify/constraints.ts)) never asks a model whether the recipe is valid. Asking the system that made a mistake to notice its own mistake shares the blind spot by construction. Ingredient membership and arithmetic are decidable, so they're plain TypeScript — fast, free, deterministic, and unit-tested in CI.

**The model's own `source` claim is discarded and recomputed.** If it says an ingredient is in your pantry and it isn't, that's caught and shown to you.

---

## Architecture

```
                    Browser (React + Vite)
                            │
              POST /api/chat/stream  (SSE)
                            │
                            ▼
              ┌──────────────────────────────┐
              │        Hono API (Node)       │
              │                              │
              │  1. load pantry + prefs      │
              │  2. openTurn()  ── telemetry │
              │  3. stream from Claude ──────┼──► delta  delta  delta …
              │     (structured output)      │
              │  4. RecipeSchema.parse()  ───┼──► recipe
              │  5. verifyRecipe()  ─────────┼──► verification   ← deterministic
              │  6. completeTurn() ── cost,  │
              │     cache status, latency ───┼──► done
              └──────────────┬───────────────┘
                             ▼
                     SQLite (turns, pantry, feedback)
```

Generation and verification are **two phases**, and the UI is honest about it: the recipe card fills in as tokens arrive, then the badge resolves from "Checking against your kitchen…" to a verdict. That pause is the product making its claim.

### Repo layout

```
packages/shared/       # ← the Zod schemas. Read this first.
  src/recipe.ts        #   RecipeSchema — used at three boundaries
  src/constraints.ts   #   CookRequest + Verification
  src/events.ts        #   SSE wire protocol (discriminated union)

apps/api/
  src/llm/models.ts    # model registry + cost accounting
  src/llm/prompts.ts   # frozen system prompt (the cached prefix)
  src/llm/generate.ts  # streaming + structured output
  src/verify/          # the deterministic constraint checker + its tests
  src/telemetry/       # turn logging — built before the UI, on purpose
  src/routes/          # chat (SSE), pantry, feedback, stats

apps/web/
  src/hooks/useRecipeStream.ts   # SSE consumer with progressive preview
  src/components/                # landing, chat, recipe card, pantry
```

---

## Why TypeScript end-to-end

The recipe schema is the single most important artifact in the codebase, and it is consumed at three separate boundaries:

```ts
zodOutputFormat(RecipeSchema)              // model boundary  — constrains generation
RecipeSchema.parse(JSON.parse(text))       // server boundary — validates before use
type Recipe = z.infer<typeof RecipeSchema> // render boundary — types the React card
```

**One definition, three consumers, drift caught at compile time.** A Python backend with a React frontend would define this in Pydantic and then either hand-maintain the TypeScript types or generate them from OpenAPI — both of which reintroduce drift on the exact artifact whose fidelity *is* the product claim. That's the trade this project can least afford.

Secondary reasons: the Anthropic TS SDK ships streaming and the Zod output helper first-class; SSE out of Node needs no ASGI/worker tuning; and an MCP server added later can import these same schemas rather than reimplementing them.

---

## Model selection

You don't pick *a* model — you pick a portfolio and match each call site to its task economics. Three axes: **task difficulty**, **latency sensitivity** (is a human watching?), and **volume × tokens**.

| Call site | Tier | Why |
| --- | --- | --- |
| Photo → ingredient list (v2) | `claude-haiku-4-5` | High volume, no judgment, structured extraction |
| Cuisine tagging, intent routing | `claude-haiku-4-5` | Near-binary, latency-critical |
| **Recipe generation** | `claude-opus-5` (default) | The user-facing turn; hard constraint satisfaction |
| Cost-optimised alternative | `claude-sonnet-5` | ~40% cheaper per turn — **measure on your eval set before switching** |

Configured via `RECIPE_MODEL`, so switching is an env var and a measurement, not a refactor. See [`apps/api/src/llm/models.ts`](apps/api/src/llm/models.ts) for the full table.

**Effort is a separate cost axis from model choice.** `RECIPE_EFFORT` (`low`…`max`) controls spend independently on Opus 5 and Sonnet 5. Opus at `medium` is genuinely strong, so "Opus is too expensive" is often a false economy that should have been an effort sweep. Run the sweep before you downgrade the tier.

### Cost, honestly

A measured turn is 3,627 input / ~2,300 output tokens. Opus is measured; the
other two are that same token profile at list rates, warm cache where the prefix
qualifies:

| Model | ≈ per turn (warm) | 200 turns/mo (one real user) | Caching |
| --- | --- | --- | --- |
| Haiku 4.5 | $0.015 | ~$3.00 | **never engages** — 3,472 < 4,096 minimum |
| Sonnet 5 | $0.036 | ~$7.20 | works (1,024 minimum) |
| Opus 5 | $0.059 | ~$11.80 | works (512 minimum) — **measured** |

**At one user, model cost is a rounding error** — the real costs are latency and your time, so v1 optimises for quality. It flips around 50K turns/month, where caching and a Haiku routing tier start paying for their complexity. Knowing when *not* to optimise matters as much as knowing how.

### Prompt caching

Caching is a prefix match, so the prompt is split deliberately:

- `SYSTEM_PROMPT` is **frozen** — no dates, no user IDs, no request data — and carries the `cache_control` breakpoint. It's also long enough to clear Opus's 512-token minimum.
- `buildUserTurn()` renders everything volatile *after* the breakpoint.

Measured on Opus 5 by running the same request under all three cache states. The
prefix is 3,472 tokens (system prompt + the compiled `RecipeSchema`); the user
turn is 155:

| | `NONE` (no `cache_control`) | `MISS` (cold) | `HIT` (warm) |
| --- | --- | --- | --- |
| `input_tokens` | 3,627 | 155 | 155 |
| `cache_write_tokens` | 0 | 3,472 | 0 |
| `cache_read_tokens` | 0 | 0 | 3,472 |
| **Input-side cost** | $0.01814 | **$0.02248 — 24% worse** | **$0.00251 — 86% less** |
| Total turn cost | $0.0723 | $0.0778 | $0.0587 |

**Caching reclassifies tokens; it does not reduce them.** All three states send
the model exactly 3,627 input tokens — `input_tokens + cache_read + cache_write`
is conserved. What changes is the rate each bucket bills at: reads at 10% of
input, writes at 125%.

That write premium is the part people miss. **A cache miss costs 24% more than
never caching at all**, so caching is a bet on locality: below a **~22% hit
rate** it loses money on this prompt shape.

Two caveats on the totals column, both learned the hard way:

- **Output tokens dominate and they're noisy.** Output ran 2,168–2,622 across
  runs (a 21% spread) and bills at $25/MTok, so it is ~96% of the cost of a
  warm turn. Compare the input-side column, not the total — an earlier version
  of this table reported a 45% saving that was mostly output-length variance
  attributed to caching.
- **No latency win was reproducible.** 28.1s cold vs 28.5s warm. Prefilling
  3,472 cached tokens is small next to decoding ~2,300, so any gain sits inside
  run-to-run noise. Caching is a cost lever here, not a speed one.

A counter-intuitive detail worth knowing: **the minimum cacheable prefix is inversely related to price.** Haiku needs 4,096 tokens before caching engages; Opus needs 512. A short-prompt Haiku route silently never caches — full price, `cache_read_input_tokens: 0`, no error. At 3,472 tokens this prefix clears Opus and Sonnet comfortably and **would silently no-op on Haiku.**

Caching fails silently, so it's measured rather than assumed: every turn's cache status is logged and shown live in the debug strip (`?debug=1`).

---

## Telemetry

Built before the UI, deliberately. "How do you know they still use it?" is only answerable with data you decided to collect on day one — you cannot backfill usage history, and a testimonial isn't evidence.

Every turn writes a row: what was asked, what was produced, whether verification passed, model, tokens, cache status, cost, latency — and afterwards the two outcome signals: **rating** (cheap, noisy) and **cooked** (rare, and the only real outcome).

`GET /api/stats` returns aggregates — turns per week, active days, cook rate, verification pass rate, cache hit rate, total spend. Aggregate-only and unauthenticated, so it's a dashboard you can screen-share.

---

## Running it

```bash
pnpm install

cp .env.example .env                    # add your ANTHROPIC_API_KEY
cp apps/web/.env.example apps/web/.env  # optional: Supabase for Google OAuth

pnpm dev        # api :8787, web :5173
```

Put the key **only** in `.env` — `.env.example` is a committed template, so a key
pasted there is one `git add` away from being published.

With `DEV_ALLOW_ANONYMOUS=1` (the default in `.env.example`) the API bypasses auth and the web app runs in local mode — so the whole UI is buildable before you set up an OAuth consent screen. The web `.env` is genuinely optional: its Supabase values ship as `<project-ref>` placeholders, and the client treats unfilled placeholders as unconfigured, so copying the file verbatim still lands you in local mode rather than on a sign-in screen you can't get past.

```bash
pnpm typecheck   # all three packages
pnpm test        # verifier unit tests
```

### Google OAuth

Supabase handles OAuth only; app data stays in SQLite. The OAuth dance is fiddly, undifferentiated work worth renting; the recipe data is the part worth owning.

1. Create a Supabase project → **Authentication → Providers → Google**.
2. Put `SUPABASE_JWKS_URL` in `.env` and `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in `apps/web/.env`.
3. Set `DEV_ALLOW_ANONYMOUS=0`.

The API verifies the Supabase JWT against the project's JWKS endpoint, so no shared secret lives in this repo and key rotation is handled upstream.

---

## Status

**v1 (this):** streaming chat · structured recipe output · deterministic verification of ingredients, cookware, time, dislikes, dietary and servings · active vs passive time · pantry + preferences + cookware · turn telemetry · Google OAuth · cost/cache instrumentation.

**v2:** repeat avoidance from logged history · use-it-first (expiry-aware pantry) · pantry photo → ingredients (vision, Haiku tier) · substitution suggestions.

**v3:** weekly plan where three dinners must *collectively* fit one pantry (real constraint satisfaction — and where escalating to Opus 5 at high effort earns its cost) · MCP server · BYOK · eval harness over fixed (pantry, cookware, constraints) cases.

Deliberately out of scope: real-time supermarket stock checking (no reliable API; substitutions plus a shopping list serve the same need better).

### Known limitations

- Ingredient matching is lexical (normalise + head-noun rules), so it will miss synonyms like "aubergine"/"eggplant". Real fix is a small embedding lookup; the current rules are deliberately predictable and testable instead.
- `DIETARY_FORBIDDEN` is a hand-maintained list. It catches the common cases and will have gaps — extend it as real users hit them.
- The streaming preview scrapes `title`/`summary` with a regex rather than a full partial-JSON parser. Cheap, and enough to make the wait feel like progress.
