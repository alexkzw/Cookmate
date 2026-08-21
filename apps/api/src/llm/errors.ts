import Anthropic from "@anthropic-ai/sdk";
import { RecipeGenerationError } from "./generate.js";

/**
 * ERROR CLASSIFICATION.
 *
 * `internal_error` was the catch-all for anything that wasn't a typed
 * RecipeGenerationError, and only the code was stored — so an 8% failure rate
 * in an eval arm was completely undiagnosable. A timeout, a rate limit and a
 * bug in our own code all looked identical in the table.
 *
 * Three things make an error record useful in production:
 *
 *   1. A STABLE CODE you can group by. "rate_limit" is a capacity problem;
 *      "schema_mismatch" is a prompt problem. Aggregating them under one label
 *      hides which one you have.
 *   2. THE MESSAGE, so you can read what actually happened without reproducing.
 *   3. THE PROVIDER'S REQUEST ID, which is what Anthropic support asks for and
 *      what lets you correlate your log with theirs.
 *
 * And one thing that matters for what you do next: whether the failure was
 * RETRYABLE. Retrying a refusal burns money for a guaranteed second refusal;
 * retrying an overload is exactly right.
 */

export interface ErrorInfo {
  /** Stable, low-cardinality, safe to GROUP BY. */
  code: string;
  /** Human-readable, truncated, secret-scrubbed. */
  message: string;
  /** HTTP status, when the provider returned one. */
  status?: number;
  /** Anthropic's request id — the thing support asks for. */
  requestId?: string;
  /** Whether a retry could plausibly have succeeded. */
  retryable: boolean;
}

const MAX_MESSAGE = 500;

/**
 * Error messages can quote request bodies, and request bodies can contain
 * credentials. Scrub before persisting: a log is a place secrets leak to.
 */
function scrub(raw: string): string {
  return raw
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1***")
    .slice(0, MAX_MESSAGE);
}

export function classifyError(err: unknown): ErrorInfo {
  // Our own typed failures already carry a meaningful code.
  if (err instanceof RecipeGenerationError) {
    return {
      code: err.code,
      message: scrub(err.message),
      // A refusal repeats; a truncation might not if the request is simplified.
      retryable: err.code === "truncated",
    };
  }

  // MUST come before the APIError branch below: APIUserAbortError EXTENDS
  // APIError, so checking the general case first swallows it and reports a
  // cancelled request as `api_error` with no status. That is the bug this
  // comment exists to prevent a second time — a user pressing Stop is not a
  // provider failure, and letting it land in the error rate corrupts the one
  // number you would page on.
  if (
    err instanceof Anthropic.APIUserAbortError ||
    (err instanceof Error && err.name === "AbortError")
  ) {
    return { code: "aborted", message: "Client aborted the request.", retryable: false };
  }

  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const requestId = err.requestID ?? undefined;
    const base = { message: scrub(err.message), status, requestId };

    if (err instanceof Anthropic.APIConnectionTimeoutError)
      return { ...base, code: "timeout", retryable: true };
    if (err instanceof Anthropic.APIConnectionError)
      return { ...base, code: "connection_error", retryable: true };
    if (status === 429) return { ...base, code: "rate_limit", retryable: true };
    if (status === 529) return { ...base, code: "overloaded", retryable: true };
    if (status === 401 || status === 403)
      return { ...base, code: "auth_error", retryable: false };
    if (status === 400) return { ...base, code: "bad_request", retryable: false };
    if (typeof status === "number" && status >= 500)
      return { ...base, code: "provider_error", retryable: true };
    return { ...base, code: "api_error", retryable: false };
  }

  if (err instanceof Error) {
    // Genuinely ours: a bug, not the provider's. Keep the class name — it's
    // usually the fastest route to the offending line.
    return { code: "internal_error", message: scrub(`${err.name}: ${err.message}`), retryable: false };
  }

  return { code: "internal_error", message: scrub(String(err)), retryable: false };
}
