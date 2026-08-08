import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

/**
 * One shared client. The SDK retries 429/5xx twice with backoff by default,
 * which is what we want; we only extend the timeout because recipe generation
 * with thinking enabled can legitimately run for a while.
 */
export const anthropic = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
  timeout: 120_000, // ms
  maxRetries: 2,
});
