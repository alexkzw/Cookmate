import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { classifyError } from "./errors.js";

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
