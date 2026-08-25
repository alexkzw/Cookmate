import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { classifyError, severityOf } from "./errors.js";

describe("classifyError", () => {
  it("classifies a user abort as `aborted`, not `api_error`", () => {
    // Regression: APIUserAbortError extends APIError, so an `instanceof
    // APIError` check placed first swallows it. Every cancelled request was
    // being recorded as a provider failure, inflating the error rate that the
    // abort branch exists to keep clean.
    expect(classifyError(new Anthropic.APIUserAbortError()).code).toBe("aborted");
  });

  it("classifies a bare AbortError as `aborted` too", () => {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    expect(classifyError(err).code).toBe("aborted");
  });

  it("an abort is never retryable — the user meant it", () => {
    expect(classifyError(new Anthropic.APIUserAbortError()).retryable).toBe(false);
  });

  it("still classifies real API errors by status", () => {
    const rate = new Anthropic.RateLimitError(429, undefined, "slow down", new Headers());
    expect(classifyError(rate).code).toBe("rate_limit");
    expect(classifyError(rate).retryable).toBe(true);
  });

  it("scrubs API keys out of anything it persists", () => {
    const err = new Error("failed with key sk-ant-api03-SECRETVALUE and Bearer abc.def");
    const info = classifyError(err);
    expect(info.message).not.toContain("SECRETVALUE");
    expect(info.message).toContain("sk-ant-***");
  });
});

describe("severityOf", () => {
  it("treats a user cancellation as info, not an error", () => {
    // The bug this guards: aborts were once classified as `api_error` and
    // logged at error level, inflating the one number you would page on.
    expect(severityOf("aborted")).toBe("info");
  });

  it.each(["rate_limit", "overloaded", "timeout", "connection_error", "provider_error"])(
    "treats %s as a warning — alarming as a rate, not as an event",
    (code) => {
      expect(severityOf(code)).toBe("warning");
    },
  );

  it.each(["auth_error", "bad_request", "schema_mismatch", "internal_error"])(
    "treats %s as critical — one occurrence is our defect",
    (code) => {
      expect(severityOf(code)).toBe("critical");
    },
  );

  it("defaults an unknown code to critical so a gap in the table is loud", () => {
    // Defaulting to `warning` would let a brand-new failure mode join the
    // background hum and stay there unnoticed.
    expect(severityOf("something_we_have_never_seen")).toBe("critical");
  });

  it("assigns a severity to every code classifyError can produce", () => {
    // Guards the drift where a new branch is added to classifyError and the
    // severity table is not updated — which would silently mark it critical.
    const codes = [
      "aborted", "refusal", "truncated", "empty_response", "schema_mismatch",
      "timeout", "connection_error", "rate_limit", "overloaded", "auth_error",
      "bad_request", "provider_error", "api_error", "internal_error",
    ];
    for (const code of codes) {
      expect(["info", "warning", "critical"]).toContain(severityOf(code));
    }
  });
});
