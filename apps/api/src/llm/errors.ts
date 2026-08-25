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

/**
 * SEVERITY — what you should DO about an error, as distinct from what it was.
 *
 * `code` answers "what happened". Severity answers "does anyone need to look".
 * They are different questions and conflating them is why error logs get
 * ignored: if every failure is an ERROR line, the one that matters is
 * indistinguishable from the 200 that don't.
 *
 * The cut is deliberately not "how bad does this sound", it is WHOSE FAULT and
 * WHAT IS THE RESPONSE:
 *
 *   info      Expected, correct behaviour. Not a defect. Never page.
 *   warning   Expected at some rate; alarming as a RATE, not as an event.
 *             The provider had a bad minute, or one input was awkward.
 *   critical  Should be impossible. A SINGLE occurrence is a defect in our
 *             code, our config or our contract with the model. Investigate one.
 *
 * That last row is the useful one. `schema_mismatch` sits there — not because
 * a malformed recipe hurts anyone (the user just sees an error) but because
 * structured outputs are supposed to make it unrepresentable, so one occurrence
 * means the schema contract is broken and every downstream guarantee is
 * suspect. Same for `bad_request`: the provider rejected a request WE built.
 *
 * DERIVED, NOT STORED, and that is a deliberate contrast with `scorer_hash`.
 * A scorer hash records what actually graded a row, so backfilling it would
 * turn a gap in the record into a false claim. Severity is not a measurement of
 * the past — it is today's policy about what deserves attention. If tomorrow we
 * decide timeouts are critical, we want that applied when reading old rows too,
 * because we are restating what we care about, not what we observed.
 */
export type Severity = "info" | "warning" | "critical";

const SEVERITY: Record<string, Severity> = {
  // Someone pressed Stop. Recording it is useful; alerting on it is noise, and
  // this app has already shipped the bug where cancellations were logged as
  // provider failures and inflated the one number you would page on.
  aborted: "info",

  // The provider, or this particular input, had a bad moment. Any of these can
  // happen on a healthy system; a SPIKE in any of them is the actual signal.
  rate_limit: "warning",
  overloaded: "warning",
  timeout: "warning",
  connection_error: "warning",
  provider_error: "warning",
  truncated: "warning",
  refusal: "warning",
  empty_response: "warning",

  // Ours. A single one is worth a look.
  auth_error: "critical", // the key is wrong, missing, or revoked
  bad_request: "critical", // we built a request the API rejected
  schema_mismatch: "critical", // structured outputs should make this impossible
  api_error: "critical", // an unmapped provider status — the taxonomy has a hole
  internal_error: "critical", // a bug in our code
};

/**
 * An unknown code is CRITICAL, not warning.
 *
 * Failing loud on the unrecognised case is the only way a gap in this table
 * announces itself. Defaulting to "warning" would let a new error code join the
 * background hum and stay there.
 */
export function severityOf(code: string): Severity {
  return SEVERITY[code] ?? "critical";
}
