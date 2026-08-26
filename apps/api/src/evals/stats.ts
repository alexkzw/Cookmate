/**
 * SIGNIFICANCE TESTING FOR THE EVAL SUITE.
 *
 * The failure this exists to prevent is the most common one in prompt
 * engineering: running a suite twice, seeing 29/36 become 32/36, and shipping
 * the change. Generation is stochastic, so a pass rate is a SAMPLE, and two
 * samples from an unchanged system differ all the time. Without an interval
 * around it, a pass rate is a number with no error bar being treated as a
 * measurement.
 *
 * This module is deliberately pure arithmetic — no database, no model, no I/O —
 * so every claim it makes is unit-testable against values you can look up.
 *
 * THREE THINGS IT REPORTS, IN THE ORDER THEY MATTER:
 *
 *   1. A CONFIDENCE INTERVAL on each arm's pass rate. Answers "how precisely do
 *      I actually know this number?" — usually much less precisely than the
 *      two decimal places in the table imply.
 *   2. A TEST between two arms. Answers "could this difference be chance?"
 *   3. A REQUIRED SAMPLE SIZE. Answers the only actionable question when the
 *      test comes back inconclusive: how many more runs would settle it, and
 *      therefore how much would settling it cost.
 *
 * The third is the one people skip, and it is the one that turns "not
 * significant" from a dead end into a budget decision.
 */

/* ------------------------------------------------------------------ *
 * Normal distribution
 * ------------------------------------------------------------------ */

/**
 * Abramowitz & Stegun 7.1.26. Max absolute error 1.5e-7, which is four orders
 * of magnitude tighter than anything that could change a decision here.
 *
 * Hand-rolled rather than pulled from a stats package on purpose: it is fifteen
 * lines, it has no dependencies to audit, and a dependency whose correctness
 * you cannot check is a strange thing to put underneath your evidence.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** P(Z <= z) for a standard normal. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Two-sided p-value for a z statistic. */
export function twoSidedP(z: number): number {
  return 2 * (1 - normalCdf(Math.abs(z)));
}

const Z_95 = 1.959964; // two-sided alpha = 0.05
const Z_POWER_80 = 0.841621; // one-sided beta = 0.20

/* ------------------------------------------------------------------ *
 * Interval on a single proportion
 * ------------------------------------------------------------------ */

export interface Interval {
  rate: number;
  lo: number;
  hi: number;
  /** hi - lo. The number that says whether the estimate is worth quoting. */
  width: number;
  n: number;
}

/**
 * WILSON SCORE INTERVAL, not the normal approximation.
 *
 * The textbook `p +/- z*sqrt(pq/n)` breaks exactly where eval suites live: small
 * n and rates near 0 or 1. At 36/36 it produces the interval [1.0, 1.0] — a
 * claim of perfect certainty from 36 observations, which is obviously false and
 * is precisely the case a passing suite hits. Wilson stays inside [0,1] and
 * keeps a sane width at the boundary, so a perfect score reports honestly as
 * "somewhere above ~90%" rather than "exactly 100%".
 */
export function wilson(successes: number, n: number, z: number = Z_95): Interval {
  if (n <= 0) return { rate: 0, lo: 0, hi: 1, width: 1, n: 0 };

  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  const lo = Math.max(0, centre - half);
  const hi = Math.min(1, centre + half);
  return { rate: p, lo, hi, width: hi - lo, n };
}

/* ------------------------------------------------------------------ *
 * Comparing two arms
 * ------------------------------------------------------------------ */

export interface Comparison {
  rateA: number;
  rateB: number;
  /** rateA - rateB, in percentage points when multiplied by 100. */
  diff: number;
  z: number;
  p: number;
  significant: boolean;
  /** True when either arm has fewer than 5 expected successes or failures. */
  underpowered: boolean;
  /**
   * Runs PER ARM needed to detect the difference actually observed, at
   * alpha=0.05 and 80% power. Null when the arms scored identically, since
   * there is no effect size to power for.
   */
  nForObserved: number | null;
}

/**
 * Pooled two-proportion z-test.
 *
 * Pooled because the null hypothesis is that both arms share one underlying
 * rate — estimating the standard error from the combined data is what makes it
 * a test OF that hypothesis rather than a description of the two samples.
 *
 * `underpowered` flags the normal approximation's own precondition (the usual
 * rule of thumb is at least 5 expected successes AND 5 expected failures per
 * arm). When it trips, read the p-value as a rough direction, not a verdict —
 * and read `nForObserved` instead.
 */
export function compareProportions(
  successesA: number,
  nA: number,
  successesB: number,
  nB: number,
): Comparison {
  const rateA = nA > 0 ? successesA / nA : 0;
  const rateB = nB > 0 ? successesB / nB : 0;
  const diff = rateA - rateB;

  if (nA === 0 || nB === 0) {
    return { rateA, rateB, diff, z: 0, p: 1, significant: false, underpowered: true, nForObserved: null };
  }

  const pooled = (successesA + successesB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));

  // se is 0 when both arms are all-pass or all-fail. There is no difference to
  // test, and dividing would produce NaN or Infinity — both of which would
  // render as a confident-looking result.
  const z = se === 0 ? 0 : diff / se;
  const p = se === 0 ? 1 : twoSidedP(z);

  const expected = [rateA * nA, (1 - rateA) * nA, rateB * nB, (1 - rateB) * nB];
  const underpowered = expected.some((e) => e < 5);

  return {
    rateA,
    rateB,
    diff,
    z,
    p,
    significant: p < 0.05,
    underpowered,
    nForObserved: diff === 0 ? null : requiredSampleSize(rateA, rateB),
  };
}

/**
 * Runs per arm needed to detect a difference between two rates.
 *
 * Standard two-proportion formula at alpha=0.05, power=0.80:
 *
 *   n = ( z_a*sqrt(2*pbar*qbar) + z_b*sqrt(p1*q1 + p2*q2) )^2 / (p1 - p2)^2
 *
 * This is the number that makes an inconclusive result actionable. "Not
 * significant" alone invites you to run it again and hope; "you would need 340
 * runs per arm, which is roughly $16 and three hours" is a decision — usually
 * the decision that this particular difference is not worth measuring, which is
 * itself worth knowing before you spend a day chasing it.
 */
export function requiredSampleSize(p1: number, p2: number): number | null {
  const delta = Math.abs(p1 - p2);
  if (delta === 0) return null;

  const pbar = (p1 + p2) / 2;
  const term1 = Z_95 * Math.sqrt(2 * pbar * (1 - pbar));
  const term2 = Z_POWER_80 * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((term1 + term2) ** 2 / (delta * delta));
}

/* ------------------------------------------------------------------ *
 * Clustering — the caveat that changes the numbers most
 * ------------------------------------------------------------------ */

/**
 * THE RUNS ARE NOT INDEPENDENT, AND EVERYTHING ABOVE ASSUMES THEY ARE.
 *
 * Three repeats of `tight-time` are three samples of the same hard question,
 * not three samples of the model. If a fixture is systematically difficult, all
 * three fail together — so 36 runs over 12 fixtures carries somewhere between
 * 12 and 36 independent observations, never the full 36.
 *
 * Treating them as 36 shrinks every interval by up to sqrt(3) and makes the
 * suite look far more precise than it is. The properly-clustered answer needs a
 * random-effects model, which is more machinery than this suite justifies — so
 * the honest move is to report BOTH ends of the range and let the reader see
 * how much of the precision is an artefact of the repeats:
 *
 *   optimistic  n = runs      (independence: certainly too narrow)
 *   conservative n = fixtures (one observation per fixture: certainly too wide)
 *
 * When those two intervals lead to the same conclusion, the clustering question
 * does not matter and you can stop thinking about it. When they disagree, the
 * result depends on an assumption you cannot support, which is exactly the
 * situation where "we measured it" quietly becomes false.
 */
export interface ClusteredInterval {
  optimistic: Interval;
  conservative: Interval;
  /** True when the two disagree about whether the rate could be >= a threshold. */
  clusteringMatters: boolean;
}

export function clusteredWilson(
  successes: number,
  runs: number,
  fixtures: number,
  threshold = 0.9,
): ClusteredInterval {
  const optimistic = wilson(successes, runs);
  // Scale the successes to the fixture-level n, preserving the rate. This is
  // the deliberately crude conservative bound described above, not an estimate.
  const clusters = Math.max(1, Math.min(fixtures, runs));
  const conservative = wilson(Math.round(optimistic.rate * clusters), clusters);

  return {
    optimistic,
    conservative,
    clusteringMatters: optimistic.lo >= threshold !== conservative.lo >= threshold,
  };
}

/* ------------------------------------------------------------------ *
 * Multiple comparisons
 * ------------------------------------------------------------------ */

/**
 * Bonferroni-corrected alpha for k pairwise comparisons.
 *
 * Comparing every condition against every other is a trap that scales badly:
 * with 4 arms there are 6 pairs, and at alpha=0.05 each, the chance of at least
 * one false positive is about 26%. Report a corrected threshold alongside the
 * raw p-values so a table of six comparisons cannot be read as six independent
 * 5% tests.
 *
 * Bonferroni is conservative and there are tighter corrections, but it is the
 * one you can explain in a sentence — and an adjustment nobody understands gets
 * ignored, which corrects nothing.
 */
export function bonferroniAlpha(comparisons: number, alpha = 0.05): number {
  return comparisons > 0 ? alpha / comparisons : alpha;
}

/** Format an interval as a percentage range, for console tables. */
export function fmtInterval(i: Interval): string {
  return `${(i.rate * 100).toFixed(1)}% [${(i.lo * 100).toFixed(0)}–${(i.hi * 100).toFixed(0)}]`;
}
