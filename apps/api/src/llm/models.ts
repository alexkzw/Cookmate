/**
 * Model registry and cost accounting.
 *
 * The point of this file is that model choice is a *per-call-site* decision
 * driven by task economics, not a single global "which model is best".
 *
 * Three axes decide a tier:
 *   1. Task difficulty  — does it need judgment, or is it extraction/routing?
 *   2. Latency          — is a human watching the tokens arrive?
 *   3. Volume × tokens  — how often does this run, and how big is each call?
 *
 * Prices are USD per million tokens, list rates as of 2026-06.
 *
 * NOTE ON CACHING — the counter-intuitive bit worth knowing:
 * the *minimum cacheable prefix* is inversely related to price. Haiku needs a
 * 4,096-token prefix before caching engages at all; Opus needs only 512. A
 * short-prompt Haiku route therefore silently never caches — you pay full
 * input price and see cache_read_input_tokens: 0 with no error to tell you.
 */

export type Tier = "fast" | "balanced" | "deep";

export interface ModelSpec {
  id: string;
  tier: Tier;
  inputPerMTok: number;
  outputPerMTok: number;
  contextWindow: number;
  /** Prefix must exceed this many tokens or caching silently no-ops. */
  minCacheableTokens: number;
  /** What this tier is for, in this app specifically. */
  useFor: string;
}

export const MODELS: Record<string, ModelSpec> = {
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    tier: "fast",
    inputPerMTok: 1,
    outputPerMTok: 5,
    contextWindow: 200_000,
    minCacheableTokens: 4096,
    useFor:
      "High volume, low judgment: parsing a pantry photo into an ingredient list, tagging cuisine, routing intent. No human waiting on prose.",
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    tier: "balanced",
    inputPerMTok: 3,
    outputPerMTok: 15,
    contextWindow: 1_000_000,
    minCacheableTokens: 1024,
    useFor:
      "The default workhorse for user-facing generation. ~40% cheaper than Opus per turn; measure on your eval set before switching the recipe route to it.",
  },
  "claude-opus-5": {
    id: "claude-opus-5",
    tier: "deep",
    inputPerMTok: 5,
    outputPerMTok: 25,
    contextWindow: 1_000_000,
    minCacheableTokens: 512,
    useFor:
      "Hard constraint satisfaction: seven odd ingredients, 20 minutes, no oven, two dietary restrictions. Also the default for the main recipe route until an eval says otherwise.",
  },
};

/** Cache reads bill at ~10% of the input rate. */
const CACHE_READ_MULTIPLIER = 0.1;
/** Cache writes bill at 125% of the input rate (5-minute TTL). */
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Actual dollar cost of one call. Logged on every turn so the /stats page can
 * answer "what does this cost to run" with a measurement rather than a guess.
 */
export function computeCostUsd(modelId: string, usage: TokenUsage): number {
  const spec = MODELS[modelId];
  if (!spec) return 0;
  const perToken = (rate: number) => rate / 1_000_000;
  return (
    usage.inputTokens * perToken(spec.inputPerMTok) +
    usage.outputTokens * perToken(spec.outputPerMTok) +
    usage.cacheReadTokens * perToken(spec.inputPerMTok) * CACHE_READ_MULTIPLIER +
    usage.cacheWriteTokens * perToken(spec.inputPerMTok) * CACHE_WRITE_MULTIPLIER
  );
}

export type CacheStatus = "HIT" | "MISS" | "PARTIAL" | "NONE";

/**
 * Classify what the cache actually did. Surfaced to the client so the debug
 * panel shows it live — the only reliable way to know your caching strategy
 * works is to watch this number in production, not to assume it from the code.
 */
export function classifyCache(usage: TokenUsage): CacheStatus {
  const { cacheReadTokens: read, cacheWriteTokens: write } = usage;
  if (read > 0 && write > 0) return "PARTIAL";
  if (read > 0) return "HIT";
  if (write > 0) return "MISS";
  return "NONE";
}

export function describeModel(modelId: string): ModelSpec | undefined {
  return MODELS[modelId];
}
