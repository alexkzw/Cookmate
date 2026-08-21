import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { RecipeSchema, type CookRequest, type Recipe } from "@cookmate/shared";
import { anthropic } from "./client.js";
import { config } from "../config.js";
import { SYSTEM_PROMPT, buildUserTurn } from "./prompts.js";
import { classifyCache, computeCostUsd, type CallUsage, type TokenUsage } from "./models.js";
import type { ConversationTurn } from "../telemetry/turns.js";

export interface GenerationResult {
  recipe: Recipe;
  usage: CallUsage;
}

export class RecipeGenerationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /**
     * Usage for the call that failed, when we got far enough to have it.
     * Undefined only when the stream itself never completed — a network error,
     * a client abort, or an API error — where no usage was ever reported.
     */
    readonly usage?: CallUsage,
  ) {
    super(message);
    this.name = "RecipeGenerationError";
  }
}

/** Tokens → money, cache verdict and wall-clock time for one completed call. */
function summariseUsage(
  message: Anthropic.Message,
  model: string,
  startedAt: number,
): CallUsage {
  const tokens: TokenUsage = {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
  return {
    ...tokens,
    costUsd: computeCostUsd(model, tokens),
    cacheStatus: classifyCache(tokens),
    model,
    effort: config.RECIPE_EFFORT,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Assemble the messages array from prior turns plus this request.
 *
 * Each earlier turn contributes the user prompt exactly as it was rendered and
 * the recipe the model replied with. Feeding the stored JSON back verbatim
 * matters: paraphrasing the assistant turn would change the prefix bytes and
 * cost the cache, and it would also misrepresent what the model actually said.
 */
function buildMessages(history: ConversationTurn[], finalUserTurn: string): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of history) {
    messages.push({ role: "user", content: turn.userTurn });
    messages.push({ role: "assistant", content: turn.recipeJson });
  }
  messages.push({ role: "user", content: finalUserTurn });
  return messages;
}

/**
 * SECOND CACHE BREAKPOINT — the conversation tail.
 *
 * Caching is a prefix match, and a conversation only ever APPENDS, so history
 * is a growing stable prefix. Multi-turn is therefore the best case for
 * caching, not a tax on it: a breakpoint on the last block of the newest turn
 * writes only the increment, and the next request reads everything before it.
 *
 * TTL is one hour rather than the five-minute default because the gap here is
 * human reading time — someone scans a recipe and then asks "can I swap the
 * chicken?", which routinely exceeds five minutes. The trade is real: a 1h
 * write costs 2x base versus 1.25x for 5m, and reads cost 0.1x. Break-even is
 * therefore ~3 requests on 1h against ~2 on 5m, so this only pays if
 * conversations actually reach a third turn. `attempts` and the turn chain are
 * logged so that assumption can be checked rather than believed.
 *
 * Single-turn requests get no breakpoint here at all — there is no prior
 * conversation to reuse, so a marker would pay the write premium for a read
 * that never happens.
 */
function withConversationBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length < 2) return messages;

  const last = messages[messages.length - 1];
  if (last === undefined || typeof last.content !== "string") return messages;

  return [
    ...messages.slice(0, -1),
    {
      role: last.role,
      content: [
        {
          type: "text" as const,
          text: last.content,
          cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
        },
      ],
    },
  ];
}

/**
 * Stream a recipe.
 *
 * Two things worth understanding here:
 *
 * 1. STRUCTURED OUTPUT + STREAMING TOGETHER.
 *    `output_config.format` constrains the model to our Zod schema, so what
 *    streams is the JSON object being built rather than prose. We forward
 *    those raw deltas to the browser anyway: the client does a tolerant
 *    partial parse to show the title and ingredients appearing live. That
 *    keeps the "something is happening" feel without a second prose call.
 *
 * 2. CACHE BREAKPOINT PLACEMENT.
 *    `cache_control` sits on the system block. Render order is tools → system
 *    → messages, so the frozen system prompt is the cached prefix and the
 *    volatile user turn falls after it. Verify it works by watching
 *    `cacheStatus` — never assume caching from reading the code.
 */
export async function streamRecipe(
  request: CookRequest,
  onTextDelta: (text: string) => void,
  signal?: AbortSignal,
  options: {
    /**
     * Replaces the rendered user turn. Used by the repair loop, which needs to
     * send the original request PLUS the verifier's findings — and must do so
     * after the cache breakpoint, so the system prompt stays byte-identical and
     * the retry reads the cached prefix instead of writing a new one.
     */
    userTurnOverride?: string;
    /** Prior turns of this conversation, oldest first. Empty for a fresh ask. */
    history?: ConversationTurn[];
  } = {},
): Promise<GenerationResult> {
  const startedAt = Date.now();
  const model = config.RECIPE_MODEL;

  const stream = anthropic.messages.stream(
    {
      model,
      // Generous because thinking is on by default on Opus 5 and max_tokens
      // caps thinking + visible output together. Too low truncates mid-recipe.
      max_tokens: 16_000,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: {
        effort: config.RECIPE_EFFORT,
        format: zodOutputFormat(RecipeSchema),
      },
      messages: withConversationBreakpoint(
        buildMessages(options.history ?? [], options.userTurnOverride ?? buildUserTurn(request)),
      ),
    },
    { signal },
  );

  stream.on("text", onTextDelta);

  const message = await stream.finalMessage();

  // Summarise usage BEFORE any failure check. Every branch below is a call we
  // were billed for, so each one carries its cost out with it — otherwise the
  // most interesting turns (the ones that failed) are the only turns with no
  // cost recorded against them.
  const usage = summariseUsage(message, model, startedAt);

  // Always check stop_reason before touching content. A refusal returns HTTP
  // 200 with empty or partial content, so indexing content[0] blindly throws.
  // (A recipe app has essentially no refusal surface, which is why we don't
  // also wire up the server-side `fallbacks` parameter here.)
  if (message.stop_reason === "refusal") {
    throw new RecipeGenerationError(
      "The model declined this request. Try rephrasing what you're craving.",
      "refusal",
      usage,
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new RecipeGenerationError(
      "The recipe was cut off before it finished. Try a simpler request.",
      "truncated",
      usage,
    );
  }

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (!text.trim()) {
    throw new RecipeGenerationError(
      "The model returned an empty response.",
      "empty_response",
      usage,
    );
  }

  // Structured outputs make this parse near-certain to succeed, but we still
  // validate: the schema is the contract, and an unvalidated object would
  // reach the verifier and the React render with only an implicit type.
  let recipe: Recipe;
  try {
    recipe = RecipeSchema.parse(JSON.parse(text));
  } catch (err) {
    throw new RecipeGenerationError(
      `Model output did not match the recipe schema: ${err instanceof Error ? err.message : String(err)}`,
      "schema_mismatch",
      usage,
    );
  }

  return { recipe, usage };
}
