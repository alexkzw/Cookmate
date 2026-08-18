import { describe, it, expect } from "vitest";
import { SlidingWindow } from "./window.js";

/**
 * Time is injected rather than mocked. A rate limiter is a function of the
 * clock, so passing `now` explicitly makes every case here a pure assertion
 * about the policy — no fake timers, no sleeping, no flakiness on a slow CI box.
 */
describe("SlidingWindow", () => {
  const T = 1_000_000; // arbitrary epoch, keeps the arithmetic readable

  it("allows exactly `limit` requests inside the window", () => {
    const w = new SlidingWindow(3, 60_000);
    expect(w.take("u", T).allowed).toBe(true);
    expect(w.take("u", T + 1).allowed).toBe(true);
    expect(w.take("u", T + 2).allowed).toBe(true);
    expect(w.take("u", T + 3).allowed).toBe(false);
  });

  it("reports how many requests remain", () => {
    const w = new SlidingWindow(3, 60_000);
    expect(w.take("u", T).remaining).toBe(2);
    expect(w.take("u", T).remaining).toBe(1);
    expect(w.take("u", T).remaining).toBe(0);
  });

  it("keys are independent — one user cannot exhaust another's allowance", () => {
    const w = new SlidingWindow(1, 60_000);
    expect(w.take("alice", T).allowed).toBe(true);
    expect(w.take("alice", T).allowed).toBe(false);
    expect(w.take("bob", T).allowed).toBe(true);
  });

  it("slides: an allowance returns as its hit ages out, not on a boundary", () => {
    const w = new SlidingWindow(2, 60_000);
    w.take("u", T);
    w.take("u", T + 30_000);
    expect(w.take("u", T + 40_000).allowed).toBe(false);

    // The FIRST hit is now 60s old, so exactly one allowance came back.
    expect(w.take("u", T + 60_001).allowed).toBe(true);
    expect(w.take("u", T + 60_002).allowed).toBe(false);

    // ...and the second hit ages out 30s later.
    expect(w.take("u", T + 90_001).allowed).toBe(true);
  });

  it("a fixed window would allow 2x the limit across a boundary; this does not", () => {
    // The regression this design exists to prevent: burn the allowance at the
    // end of one minute and immediately burn it again at the start of the next.
    const w = new SlidingWindow(5, 60_000);
    for (let i = 0; i < 5; i += 1) expect(w.take("u", T + 59_000 + i).allowed).toBe(true);
    for (let i = 0; i < 5; i += 1) expect(w.take("u", T + 60_100 + i).allowed).toBe(false);
  });

  it("retryAfterSeconds is when the oldest hit expires, and never 0", () => {
    const w = new SlidingWindow(1, 60_000);
    w.take("u", T);
    const denied = w.take("u", T + 10_000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(50);

    // A caller told to retry in 0 seconds retries immediately, forever.
    const atTheWire = w.take("u", T + 59_999);
    expect(atTheWire.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("peek does not consume an allowance", () => {
    const w = new SlidingWindow(1, 60_000);
    expect(w.peek("u", T).remaining).toBe(1);
    expect(w.peek("u", T).remaining).toBe(1);
    expect(w.take("u", T).allowed).toBe(true);
    expect(w.peek("u", T).allowed).toBe(false);
  });

  it("sweep drops keys whose hits have all expired", () => {
    const w = new SlidingWindow(5, 60_000);
    w.take("alice", T);
    w.take("bob", T + 30_000);
    expect(w.size).toBe(2);

    w.sweep(T + 61_000); // alice's hit is gone, bob's is not
    expect(w.size).toBe(1);
    w.sweep(T + 91_000);
    expect(w.size).toBe(0);
  });
});
