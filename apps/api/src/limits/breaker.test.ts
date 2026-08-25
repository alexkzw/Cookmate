import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "./breaker.js";

/**
 * The breaker's job is to convert a slow failure into a fast one. These tests
 * are written around the two ways that goes wrong: opening on something that
 * isn't the provider's fault (an outage you caused yourself), and failing to
 * close again after recovery (an outage that outlives the incident).
 */

const cfg = { threshold: 3, cooldownMs: 30_000, probeTimeoutMs: 60_000 };
const t0 = 1_000_000;

/** Fail n times with a code that counts as a provider fault. */
function tripIt(b: CircuitBreaker, code = "provider_error", n = 3, at = t0): void {
  for (let i = 0; i < n; i += 1) b.recordFailure({ code }, at);
}

describe("CircuitBreaker", () => {
  it("starts closed and allows traffic", () => {
    const b = new CircuitBreaker(cfg);
    expect(b.state(t0)).toBe("closed");
    expect(b.allow(t0)).toBe(true);
  });

  it("stays closed below the threshold", () => {
    const b = new CircuitBreaker(cfg);
    tripIt(b, "provider_error", 2);
    expect(b.state(t0)).toBe("closed");
    expect(b.allow(t0)).toBe(true);
  });

  it("opens on the threshold-th consecutive provider fault", () => {
    const b = new CircuitBreaker(cfg);
    tripIt(b);
    expect(b.state(t0)).toBe("open");
    expect(b.allow(t0)).toBe(false);
  });

  /**
   * The most important test here. If a refusal or a schema mismatch could open
   * the circuit, one awkward input would take the app down for every user —
   * a self-inflicted outage caused by the thing meant to prevent outages.
   */
  it.each(["refusal", "schema_mismatch", "bad_request", "aborted", "internal_error"])(
    "never opens on %s — that is not evidence about the provider",
    (code) => {
      const b = new CircuitBreaker(cfg);
      tripIt(b, code, 10);
      expect(b.state(t0)).toBe("closed");
      expect(b.allow(t0)).toBe(true);
    },
  );

  it("resets the failure count when a call succeeds", () => {
    const b = new CircuitBreaker(cfg);
    tripIt(b, "timeout", 2);
    b.recordSuccess();
    tripIt(b, "timeout", 2);
    // 2 + 2 would have tripped a naive total; consecutive is what matters.
    expect(b.state(t0)).toBe("closed");
  });

  it("a non-provider failure also clears the count — the provider answered", () => {
    const b = new CircuitBreaker(cfg);
    tripIt(b, "overloaded", 2);
    b.recordFailure({ code: "refusal" }, t0);
    tripIt(b, "overloaded", 2);
    expect(b.state(t0)).toBe("closed");
  });

  it("half-opens once the cooldown has elapsed", () => {
    const b = new CircuitBreaker(cfg);
    tripIt(b);
    expect(b.state(t0 + 29_000)).toBe("open");
    expect(b.state(t0 + 30_000)).toBe("half_open");
  });

  it("lets exactly one caller probe while half-open", () => {
    const b = new CircuitBreaker(cfg);
    tripIt(b);
    const at = t0 + 31_000;
    expect(b.allow(at)).toBe(true); // the probe
    expect(b.allow(at)).toBe(false); // everyone else waits
    expect(b.allow(at)).toBe(false);
  });

  it("closes fully when the probe succeeds", () => {
    const b = new CircuitBreaker(cfg);
    tripIt(b);
    const at = t0 + 31_000;
    b.allow(at);
    b.recordSuccess();
    expect(b.state(at)).toBe("closed");
    expect(b.allow(at)).toBe(true);
  });

  it("restarts the full cooldown when the probe fails", () => {
    const b = new CircuitBreaker(cfg);
    tripIt(b);
    const probeAt = t0 + 31_000;
    b.allow(probeAt);
    b.recordFailure({ code: "provider_error" }, probeAt);

    // Without re-stamping openedAt, this would already be half-open again and
    // would hammer a provider that just demonstrated it is still down.
    expect(b.state(probeAt + 1_000)).toBe("open");
    expect(b.state(probeAt + 30_000)).toBe("half_open");
  });

  /**
   * The probe is a lease, not a lock. `decide()` hands the slot out before the
   * call happens, and a later gate can still refuse the request — so a probe
   * that never reports back must not wedge the breaker half-open forever.
   */
  it("hands out another probe when the first is never reported", () => {
    const b = new CircuitBreaker(cfg);
    tripIt(b);
    const first = t0 + 31_000;
    expect(b.allow(first)).toBe(true);
    expect(b.allow(first + 59_000)).toBe(false); // lease still live
    expect(b.allow(first + 60_001)).toBe(true); // expired; try again
  });

  it("reports retryAfter counting down, and 0 when closed", () => {
    const b = new CircuitBreaker(cfg);
    expect(b.retryAfterSeconds(t0)).toBe(0);
    tripIt(b);
    expect(b.retryAfterSeconds(t0)).toBe(30);
    expect(b.retryAfterSeconds(t0 + 20_000)).toBe(10);
    // Never 0 while open — telling a caller to retry immediately invites a loop.
    expect(b.retryAfterSeconds(t0 + 30_000)).toBe(1);
  });
});
