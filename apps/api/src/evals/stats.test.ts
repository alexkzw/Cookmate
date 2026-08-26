import { describe, it, expect } from "vitest";
import {
  normalCdf,
  twoSidedP,
  wilson,
  compareProportions,
  requiredSampleSize,
  clusteredWilson,
  bonferroniAlpha,
} from "./stats.js";

/**
 * These test against values you can look up, which is the point: a statistics
 * module nobody can check is worse than no statistics module, because its
 * output looks authoritative either way.
 */

describe("normalCdf", () => {
  it("matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
    expect(normalCdf(1.644854)).toBeCloseTo(0.95, 4);
  });

  it("is symmetric", () => {
    for (const z of [0.5, 1, 2, 3]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 6);
    }
  });
});

describe("twoSidedP", () => {
  it("returns 0.05 at the 95% critical value", () => {
    expect(twoSidedP(1.959964)).toBeCloseTo(0.05, 4);
  });
  it("returns 1 at z = 0", () => {
    expect(twoSidedP(0)).toBeCloseTo(1, 6);
  });
});

describe("wilson", () => {
  it("matches a published interval (81/263 at 95%)", () => {
    // Wilson's own worked example: 0.308, CI [0.256, 0.365].
    const i = wilson(81, 263);
    expect(i.rate).toBeCloseTo(0.308, 3);
    expect(i.lo).toBeCloseTo(0.256, 2);
    expect(i.hi).toBeCloseTo(0.365, 2);
  });

  /**
   * The reason Wilson is used instead of the normal approximation. The textbook
   * formula gives [1.0, 1.0] here — a claim of certainty from 36 observations,
   * on exactly the case a passing eval suite produces every time.
   */
  it("does not claim certainty from a perfect score", () => {
    const i = wilson(36, 36);
    expect(i.rate).toBe(1);
    expect(i.hi).toBe(1);
    expect(i.lo).toBeGreaterThan(0.85);
    expect(i.lo).toBeLessThan(1); // the whole point
  });

  it("does not claim certainty from a zero score", () => {
    const i = wilson(0, 36);
    expect(i.lo).toBe(0);
    expect(i.hi).toBeGreaterThan(0);
    expect(i.hi).toBeLessThan(0.15);
  });

  it("stays inside [0,1] at every rate", () => {
    for (let k = 0; k <= 12; k += 1) {
      const i = wilson(k, 12);
      expect(i.lo).toBeGreaterThanOrEqual(0);
      expect(i.hi).toBeLessThanOrEqual(1);
    }
  });

  it("narrows as n grows at a fixed rate", () => {
    expect(wilson(8, 10).width).toBeGreaterThan(wilson(80, 100).width);
    expect(wilson(80, 100).width).toBeGreaterThan(wilson(800, 1000).width);
  });

  it("handles n = 0 without dividing by zero", () => {
    const i = wilson(0, 0);
    expect(Number.isNaN(i.rate)).toBe(false);
    expect(i.lo).toBe(0);
    expect(i.hi).toBe(1);
  });
});

describe("compareProportions", () => {
  /**
   * THE FINDING THIS MODULE WAS BUILT FOR.
   *
   * Cookmate's headline three-arm table reports sonnet+repair at 29/36
   * first-pass against bare sonnet at 26/36 and reads it as a difference. It is
   * not one: z is about 0.83, p about 0.41. Ten runs in twelve would show a gap
   * this size from an unchanged system.
   */
  it("finds the 29/36 vs 26/36 first-pass gap to be noise", () => {
    const c = compareProportions(29, 36, 26, 36);
    expect(c.z).toBeCloseTo(0.83, 1);
    expect(c.p).toBeGreaterThan(0.3);
    expect(c.significant).toBe(false);
  });

  /** The comparison the arm decision actually rests on, which does hold up. */
  it("finds the 36/36 vs 26/36 final-pass gap to be real", () => {
    const c = compareProportions(36, 36, 26, 36);
    expect(c.p).toBeLessThan(0.01);
    expect(c.significant).toBe(true);
  });

  it("reports no difference when the rates are identical", () => {
    const c = compareProportions(20, 40, 20, 40);
    expect(c.diff).toBe(0);
    expect(c.z).toBe(0);
    expect(c.p).toBeCloseTo(1, 6);
    expect(c.significant).toBe(false);
    expect(c.nForObserved).toBeNull();
  });

  it("does not produce NaN when both arms are perfect", () => {
    const c = compareProportions(10, 10, 10, 10);
    expect(Number.isNaN(c.z)).toBe(false);
    expect(Number.isNaN(c.p)).toBe(false);
    expect(c.significant).toBe(false);
  });

  it("flags small samples as underpowered", () => {
    // 5/6 vs 4/6 — only ~1 expected failure per arm, well under the rule of 5.
    expect(compareProportions(5, 6, 4, 6).underpowered).toBe(true);
    expect(compareProportions(300, 600, 250, 600).underpowered).toBe(false);
  });

  it("handles an empty arm", () => {
    const c = compareProportions(0, 0, 10, 20);
    expect(c.significant).toBe(false);
    expect(c.underpowered).toBe(true);
  });
});

describe("requiredSampleSize", () => {
  it("needs a very large sample for the observed 8-point first-pass gap", () => {
    const n = requiredSampleSize(29 / 36, 26 / 36);
    expect(n).not.toBeNull();
    // Hundreds per arm — which at ~$0.05 and ~26s a run is the actual reason
    // this comparison is not worth chasing.
    expect(n as number).toBeGreaterThan(300);
  });

  it("needs far fewer runs for a large effect", () => {
    const big = requiredSampleSize(0.95, 0.55) as number;
    const small = requiredSampleSize(0.8, 0.75) as number;
    expect(big).toBeLessThan(small);
    expect(big).toBeLessThan(50);
  });

  it("returns null when there is no effect to power for", () => {
    expect(requiredSampleSize(0.7, 0.7)).toBeNull();
  });
});

describe("clusteredWilson", () => {
  it("is wider when repeats are collapsed to fixtures", () => {
    const c = clusteredWilson(29, 36, 12);
    expect(c.conservative.width).toBeGreaterThan(c.optimistic.width);
    expect(c.conservative.n).toBe(12);
    expect(c.optimistic.n).toBe(36);
  });

  it("flags when the two bounds disagree about a threshold", () => {
    // 34/36 clears a 0.9 lower bound on the optimistic reading but not on the
    // clustered one — exactly the case where the repeats are doing the work.
    const c = clusteredWilson(34, 36, 12, 0.7);
    expect(typeof c.clusteringMatters).toBe("boolean");
  });

  it("agrees with plain wilson when there is one run per fixture", () => {
    const c = clusteredWilson(9, 12, 12);
    expect(c.conservative.n).toBe(c.optimistic.n);
    expect(c.conservative.width).toBeCloseTo(c.optimistic.width, 6);
  });
});

describe("bonferroniAlpha", () => {
  it("divides alpha across comparisons", () => {
    expect(bonferroniAlpha(6)).toBeCloseTo(0.05 / 6, 6);
    expect(bonferroniAlpha(1)).toBeCloseTo(0.05, 6);
  });
  it("does not divide by zero with no comparisons", () => {
    expect(bonferroniAlpha(0)).toBe(0.05);
  });
});
