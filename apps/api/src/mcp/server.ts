import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CookRequestSchema, RecipeSchema, VerificationSchema, type CookRequest } from "@cookmate/shared";
import { config } from "../config.js";
import {
  addToShoppingList,
  getPantry,
  getPreferences,
  getShoppingList,
  removeFromShoppingList,
  upsertUser,
} from "../db/index.js";
import { generateVerifiedRecipe } from "../llm/verified.js";
import { classifyError } from "../llm/errors.js";
import { RecipeGenerationError } from "../llm/generate.js";
import { decide } from "../limits/policy.js";
import { recordLimitEvent, reserve } from "../limits/budget.js";
import { providerBreaker } from "../limits/breaker.js";
import { openTurn, completeTurn, failTurn } from "../telemetry/turns.js";
import { buildUserTurn } from "../llm/prompts.js";

/**
 * COOKMATE AS AN MCP SERVER.
 *
 * Direction matters and is easy to get backwards: this makes Cookmate
 * **callable by** an agent. It is the supply side. It does not make Cookmate an
 * agent — nothing here chooses a tool or runs a loop.
 *
 * It is also NOT a second service. It is a second entry point into the same
 * core: the same Zod schemas, the same `generateVerifiedRecipe`, the same
 * verifier, the same admission policy, the same turn log. If any of that had
 * been reimplemented here, the whole argument for one TypeScript codebase would
 * collapse on the first drift.
 *
 * THREE THINGS THAT ARE EASY TO GET WRONG AND MATTER MORE THAN THE TOOLS:
 *
 * 1. LIMITS STILL APPLY. An MCP call never touches Hono, so it never runs
 *    `enforceLimits`. Without care this becomes an unmetered door into the
 *    expensive endpoint — an agent looping on `suggest_recipe` with no rate
 *    limit and no cost cap. The policy lives in `limits/policy.ts` as a pure
 *    function precisely so both doors share it.
 *
 * 2. TELEMETRY STILL APPLIES. Turns opened here are written to the same table,
 *    so `/api/stats` keeps telling the truth about spend and pass rate rather
 *    than silently under-reporting whatever arrived over stdio.
 *
 * 3. IDENTITY IS CONFIGURATION, NOT A REQUEST FIELD. A stdio server is a
 *    subprocess of one client, running as one person — there is no per-call
 *    identity to authenticate. So the user is pinned at boot and the tools
 *    never accept a user id. Accepting one would mean any caller could read any
 *    kitchen by asking nicely.
 *
 * HONEST LIMITATION: this is a separate process from the API, so it enforces
 * its own in-memory rate window. The cost caps are shared, because those live
 * in SQLite. That is the same trade already documented for running more than
 * one API process, and it resolves the same way — the window moves to Redis.
 */

/**
 * Whose kitchen this server speaks for.
 *
 * Explicit and fail-fast: a server that silently defaulted to someone else's
 * data would be a data-leak bug wearing a convenience feature's clothes.
 */
function resolveUserId(): string {
  const explicit = config.MCP_USER_ID?.trim();
  if (explicit) return explicit;
  if (config.DEV_ALLOW_ANONYMOUS) return "dev-local-user";
  throw new Error(
    "MCP_USER_ID is required. It names whose pantry, preferences and spend this " +
      "server acts on — there is no per-call identity over stdio. " +
      "Set DEV_ALLOW_ANONYMOUS=1 to use the local dev user instead.",
  );
}

const USER_ID = resolveUserId();
upsertUser(USER_ID, null, null);

/** Every tool returns this shape; `isError` is how MCP reports a failure. */
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const server = new McpServer(
  { name: "cookmate", version: "0.1.0" },
  {
    instructions:
      "Cookmate suggests meals someone can actually cook right now, given the " +
      "ingredients they have, the appliances they own and the time they've got. " +
      "Every recipe is checked by a deterministic verifier after generation, and " +
      "the verdict is returned alongside it — read it rather than assuming the " +
      "recipe is achievable. Call get_pantry before suggesting anything; the " +
      "pantry is server-owned and cannot be supplied in the request. It is read " +
      "fresh on every call, so a get_pantry result from earlier in a long " +
      "conversation may be out of date — `suggest_recipe` returns the evidence " +
      "it actually used in `groundedIn`, and that is the authority.",
  },
);

/* ---------------------------------------------------------------- *
 * get_pantry — read
 * ---------------------------------------------------------------- */

server.registerTool(
  "get_pantry",
  {
    title: "Get the kitchen",
    description:
      "Read what this person has: pantry ingredients, appliances they own, " +
      "dislikes and dietary requirements. This is the evidence every recipe is " +
      "verified against, so read it before suggesting anything.",
    inputSchema: {},
    outputSchema: {
      pantry: z.array(z.string()),
      cookware: z.array(z.string()),
      dislikes: z.array(z.string()),
      dietary: z.array(z.string()),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  () => {
    const prefs = getPreferences(USER_ID);
    const out = {
      pantry: getPantry(USER_ID),
      cookware: prefs.cookware as string[],
      dislikes: prefs.dislikes,
      dietary: prefs.dietary,
    };
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Pantry (${out.pantry.length}): ${out.pantry.join(", ") || "empty"}\n` +
            `Appliances: ${out.cookware.join(", ") || "none declared — hand tools only"}\n` +
            `Dislikes: ${out.dislikes.join(", ") || "none"}\n` +
            `Dietary: ${out.dietary.join(", ") || "none"}`,
        },
      ],
      structuredContent: out,
    };
  },
);

/* ---------------------------------------------------------------- *
 * suggest_recipe — the expensive one
 * ---------------------------------------------------------------- */

/**
 * Reuses the app's own request schema, minus the four server-owned fields.
 *
 * Same `.omit()` as the HTTP route, and for the same reason: the pantry is the
 * evidence a recipe is judged against, so a caller that could supply it would
 * be defining its own pass criteria.
 *
 * Passed as a whole schema rather than `.shape`, which matters more than it
 * looks. `.shape` hands over the fields and drops `.strict()`, so an extra
 * `pantry` key would be silently STRIPPED instead of rejected — the exact
 * "silently ignored" failure this project has been bitten by before, where the
 * caller believes it supplied something and the server quietly used its own
 * value. Keeping the schema intact turns that into a visible error.
 */
const SuggestInput = CookRequestSchema.omit({
  pantry: true,
  dislikes: true,
  dietary: true,
  cookware: true,
});

server.registerTool(
  "suggest_recipe",
  {
    title: "Suggest a recipe",
    description:
      "Generate one recipe grounded in this person's kitchen, then verify it " +
      "deterministically and return both. The verification is the point: it " +
      "recomputes every claim the model made about what's in the pantry, so " +
      "`verification.ok === false` means the recipe genuinely does not fit and " +
      "the violations say exactly how. Costs real money and takes ~30 seconds.\n\n" +
      "The pantry, dislikes, dietary needs and appliances are read from the " +
      "database AT CALL TIME and cannot be passed in — they are the evidence the " +
      "recipe is judged against. They may differ from an earlier get_pantry " +
      "result if the person edited their kitchen since. The `groundedIn` field " +
      "in the response is the evidence actually used: trust it over anything " +
      "read earlier in the conversation.",
    inputSchema: SuggestInput,
    outputSchema: {
      recipe: RecipeSchema,
      verification: VerificationSchema,
      /**
       * The evidence this recipe was actually judged against.
       *
       * Returned because an MCP conversation is long-lived and the database is
       * not frozen: a client that called get_pantry ten minutes ago may be
       * holding a stale snapshot, and without this it cannot tell "the kitchen
       * changed" from "the tool is lying". Echoing the evidence makes the
       * response self-describing — the same reason the verifier reports what it
       * resolved rather than only whether it passed.
       */
      groundedIn: z.object({
        pantry: z.array(z.string()),
        cookware: z.array(z.string()),
        dislikes: z.array(z.string()),
        dietary: z.array(z.string()),
      }),
      attempts: z.number(),
      costUsd: z.number(),
    },
    annotations: {
      readOnlyHint: false, // it spends money and writes a turn row
      destructiveHint: false,
      idempotentHint: false, // generation is stochastic; two calls differ
      openWorldHint: true, // reaches an external model API
    },
  },
  async (args) => {
    // Same four gates the HTTP route runs, from the same pure function.
    const refusal = decide(USER_ID);
    if (refusal) {
      recordLimitEvent(USER_ID, refusal.reason, refusal.detail);
      return fail(
        `${refusal.message} (${refusal.reason}; retry in ~${refusal.retryAfterSeconds}s)`,
      );
    }
    const release = reserve(USER_ID);

    const stored = getPreferences(USER_ID);
    const request: CookRequest = {
      ...args,
      pantry: getPantry(USER_ID),
      dislikes: stored.dislikes,
      dietary: stored.dietary,
      cookware: stored.cookware,
    };

    const turnId = openTurn(USER_ID, request, {
      userTurn: buildUserTurn(request),
      parentTurnId: null,
    });

    try {
      const result = await generateVerifiedRecipe(request, () => {}, { repair: true });
      // Both doors must REPORT to the breaker, not just consult it. `decide()`
      // already gates this call, so MCP inherits the protection — but a breaker
      // that is only fed by the HTTP route would never trip on a stdio-only
      // deployment, and would sit closed through an outage it could see. Same
      // lesson as the limits themselves: a second entry point is a second place
      // to forget.
      providerBreaker.recordSuccess();
      completeTurn(turnId, {
        recipe: result.recipe,
        verification: result.verification,
        ...result.usage,
        attempts: result.attempts,
        firstPassOk: result.firstPassOk,
        firstPassVerification: result.firstPassVerification,
      });

      const v = result.verification;
      const groundedIn = {
        pantry: request.pantry,
        cookware: request.cookware as string[],
        dislikes: request.dislikes,
        dietary: request.dietary,
      };

      const summary = [
        `${result.recipe.title} — ${result.recipe.summary}`,
        ``,
        // Stated first and in prose, not just in the structured payload: a
        // client reading only the text must still see what this was judged
        // against, or it will compare against whatever it remembers.
        `Grounded in the kitchen as it is RIGHT NOW — pantry: ` +
          `${groundedIn.pantry.join(", ") || "empty"}` +
          (groundedIn.dietary.length ? ` · dietary: ${groundedIn.dietary.join(", ")}` : "") +
          (groundedIn.dislikes.length ? ` · dislikes: ${groundedIn.dislikes.join(", ")}` : "") +
          `. If that differs from an earlier get_pantry, the kitchen was edited since.`,
        ``,
        v.ok
          ? `VERIFIED: fits this kitchen. ${v.activeMinutes} min hands-on of ${v.totalMinutes} total.`
          : `NOT VERIFIED — ${v.violations.length} problem(s):\n` +
            v.violations.map((x) => `  · ${x.detail}`).join("\n"),
        v.shoppingList.length > 0 ? `\nWould need buying: ${v.shoppingList.join(", ")}` : "",
        v.uncertain.length > 0
          ? `\nCouldn't classify: ${v.uncertain.join(", ")} — treat with care.`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: {
          recipe: result.recipe,
          verification: v,
          groundedIn,
          attempts: result.attempts,
          costUsd: result.usage.costUsd,
        },
      };
    } catch (err) {
      const info = classifyError(err);
      providerBreaker.recordFailure(info);
      failTurn(turnId, info, err instanceof RecipeGenerationError ? err.usage : undefined);
      // The turn id goes to the caller for the same reason it goes to the
      // browser: it is the reference that turns a failure report into a lookup.
      return fail(
        `Couldn't generate a recipe (${info.code}): ${info.message} [ref ${turnId.slice(0, 8)}]`,
      );
    } finally {
      // The lease must be released on every path, including the failure one,
      // or a failed call holds budget until its 180s expiry.
      release();
    }
  },
);

/* ---------------------------------------------------------------- *
 * Shopping list — the only writes exposed
 * ---------------------------------------------------------------- */

server.registerTool(
  "get_shopping_list",
  {
    title: "Get the shopping list",
    description: "Read what's on this person's shopping list, and which recipe put it there.",
    inputSchema: {},
    outputSchema: { items: z.array(z.object({ name: z.string(), addedAt: z.string() })) },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  () => {
    const items = getShoppingList(USER_ID);
    return {
      content: [
        {
          type: "text" as const,
          text: items.length
            ? items.map((i) => `· ${i.name}`).join("\n")
            : "The shopping list is empty.",
        },
      ],
      structuredContent: { items: items.map((i) => ({ name: i.name, addedAt: i.addedAt })) },
    };
  },
);

server.registerTool(
  "add_to_shopping_list",
  {
    title: "Add to the shopping list",
    description:
      "Add ingredients to the shopping list. Items already on it are ignored, " +
      "so calling this twice with the same list is safe. Pass `fromTurn` with " +
      "the turn id from suggest_recipe to record which recipe needed them.",
    inputSchema: {
      items: z.array(z.string().min(1).max(120)).min(1).max(50),
      fromTurn: z.string().max(64).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false, // purely additive
      idempotentHint: true, // UNIQUE(user_id, name) + INSERT OR IGNORE
      openWorldHint: false,
    },
  },
  ({ items, fromTurn }) => {
    const added = addToShoppingList(USER_ID, items, fromTurn ?? null);
    const skipped = items.length - added.length;
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Added ${added.length}: ${added.join(", ") || "nothing"}` +
            (skipped > 0 ? ` (${skipped} already on the list)` : ""),
        },
      ],
    };
  },
);

server.registerTool(
  "remove_from_shopping_list",
  {
    title: "Remove from the shopping list",
    description: "Remove items from the shopping list, e.g. once they've been bought.",
    inputSchema: { items: z.array(z.string().min(1).max(120)).min(1).max(50) },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true, // it deletes; the client should be able to confirm
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  ({ items }) => {
    const removed = removeFromShoppingList(USER_ID, items);
    return { content: [{ type: "text" as const, text: `Removed ${removed} item(s).` }] };
  },
);

/*
 * DELIBERATELY NOT EXPOSED: writing the pantry.
 *
 * The pantry is the evidence every recipe is verified against. An agent that
 * quietly appended to it wouldn't produce a visible error — it would produce
 * recipes that pass verification against a kitchen the person doesn't have,
 * which is the exact failure this project exists to prevent, arriving through
 * the front door. Reads are cheap to be wrong about; writes to the evidence are
 * not. The shopping list is safe to expose because being wrong about it costs
 * someone a duplicated line on a list.
 */

async function main(): Promise<void> {
  // stdout is the transport. Anything written there that isn't JSON-RPC
  // corrupts the protocol, so diagnostics go to stderr — including this one.
  console.error(
    `cookmate mcp · user ${USER_ID} · ${config.RECIPE_MODEL} · db ${config.DATABASE_PATH}`,
  );
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
