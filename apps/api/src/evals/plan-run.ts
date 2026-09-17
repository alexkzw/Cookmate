import { verifyAllocation } from "../verify/allocation.js";
import { planMeals, plannerPromptHash } from "../llm/planner.js";
import { PLAN_FIXTURES, planFixtureSetHash, type PlanFixture } from "./plan-fixtures.js";
import { config } from "../config.js";

/**
 * THE MEAL-PLAN EVAL.
 *
 * SCORES THE PLANNER ONLY — not the recipes it leads to. That is a deliberate
 * scoping decision and it is what makes this suite runnable often enough to be
 * useful:
 *
 *   planner only   10 fixtures x ~1 call   ≈ $0.16 and ~60s
 *   full pipeline  10 fixtures x ~4 calls  ≈ $2.00 and ~13 minutes
 *
 * An eval that costs $2 and thirteen minutes gets run when someone remembers.
 * One that costs sixteen cents gets run on every prompt edit, which is the only
 * cadence at which a regression is caught while the cause is still obvious.
 *
 * The recipes are not unscored — they are covered by the existing 12-fixture
 * suite, which already measures exactly that. Re-measuring it here would pay
 * twelve times over for a number this suite is not asking about. Test the thing
 * you changed; the same instinct as `measure:limits` proving a threshold by
 * lowering the limit rather than raising the load.
 *
 * AND THERE IS NO JUDGE. The allocation verifier is deterministic, so the whole
 * metric is arithmetic — no model grades this suite, nothing needs calibrating,
 * and the number means the same thing every time it is computed.
 */

interface FixtureOutcome {
  fixture: PlanFixture;
  /** What the planner decided. */
  feasible: boolean;
  /** Did the allocation survive the deterministic checker? */
  allocationOk: boolean;
  violations: string[];
  /** Claims on ingredients that are not in the pantry — the hallucination count. */
  phantomCount: number;
  doubleAllocatedCount: number;
  costUsd: number;
  latencyMs: number;
  error?: string;
}

async function runFixture(fixture: PlanFixture): Promise<FixtureOutcome> {
  const started = Date.now();
  try {
    const { allocation, usage } = await planMeals(
      fixture.request,
      fixture.pantry,
      fixture.dislikes,
      fixture.dietary,
    );
    const verification = verifyAllocation(allocation, fixture.pantry, fixture.request.days);

    return {
      fixture,
      feasible: allocation.feasible,
      allocationOk: verification.ok,
      violations: verification.violations.map((v) => `${v.kind}: ${v.detail}`),
      phantomCount: verification.violations.filter((v) => v.kind === "phantom_ingredient").length,
      doubleAllocatedCount: verification.violations.filter((v) => v.kind === "double_allocated")
        .length,
      costUsd: usage.costUsd,
      latencyMs: usage.latencyMs,
    };
  } catch (err) {
    return {
      fixture,
      feasible: false,
      allocationOk: false,
      violations: [],
      phantomCount: 0,
      doubleAllocatedCount: 0,
      costUsd: 0,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function report(outcomes: FixtureOutcome[]): void {
  /**
   * THE FEASIBILITY CONFUSION MATRIX — the headline result.
   *
   * A single "pass rate" would hide the only distinction that matters here.
   * The two ways of being wrong have completely different costs:
   *
   *   FALSE POSITIVE (planned when it should have refused) is the dangerous
   *     one. It means the planner invented dinners the pantry cannot support,
   *     and the user finds out at the stove. This is the number to drive to
   *     zero, and it is the reason the adversarial fixtures exist.
   *
   *   FALSE NEGATIVE (refused when a plan was possible) is merely annoying.
   *     The user goes and cooks something else.
   *
   * Reporting one accuracy figure would let a model trade the second for the
   * first and look like it improved.
   */
  let truePos = 0;
  let falsePos = 0;
  let trueNeg = 0;
  let falseNeg = 0;

  for (const o of outcomes) {
    if (o.fixture.expectFeasible && o.feasible) truePos += 1;
    else if (o.fixture.expectFeasible && !o.feasible) falseNeg += 1;
    else if (!o.fixture.expectFeasible && o.feasible) falsePos += 1;
    else trueNeg += 1;
  }

  const feasibleCases = outcomes.filter((o) => o.fixture.expectFeasible && o.feasible);
  const allocationPasses = feasibleCases.filter((o) => o.allocationOk).length;
  const totalCost = outcomes.reduce((sum, o) => sum + o.costUsd, 0);
  const avgLatency =
    outcomes.reduce((sum, o) => sum + o.latencyMs, 0) / Math.max(1, outcomes.length);
  const phantoms = outcomes.reduce((sum, o) => sum + o.phantomCount, 0);
  const doubles = outcomes.reduce((sum, o) => sum + o.doubleAllocatedCount, 0);

  console.log("");
  console.log(`  planner model   ${config.PLAN_MODEL} (effort: ${config.PLAN_EFFORT})`);
  console.log(`  planner prompt  ${plannerPromptHash()}`);
  console.log(`  fixture set     ${planFixtureSetHash()}`);
  console.log("");
  console.log("  ── FEASIBILITY DECISION ──────────────────────────────────");
  console.log(`  correctly planned   ${truePos}/${truePos + falseNeg}`);
  console.log(`  correctly refused   ${trueNeg}/${trueNeg + falsePos}`);
  console.log(
    `  INVENTED A PLAN     ${falsePos}   ← the dangerous failure; drive to 0`,
  );
  console.log(`  over-cautious       ${falseNeg}   (refused a possible plan)`);
  console.log("");
  console.log("  ── ALLOCATION QUALITY (on plans it produced) ─────────────");
  console.log(`  passed the verifier ${allocationPasses}/${feasibleCases.length}`);
  console.log(`  phantom ingredients ${phantoms}`);
  console.log(`  double-allocated    ${doubles}`);
  console.log("");
  console.log("  ── COST ──────────────────────────────────────────────────");
  console.log(`  total               $${totalCost.toFixed(4)}`);
  console.log(`  per fixture         $${(totalCost / Math.max(1, outcomes.length)).toFixed(4)}`);
  console.log(`  avg latency         ${(avgLatency / 1000).toFixed(1)}s`);
  console.log("");

  console.log("  ── PER FIXTURE ───────────────────────────────────────────");
  for (const o of outcomes) {
    const expected = o.fixture.expectFeasible ? "plan" : "refuse";
    const got = o.error ? "ERROR" : o.feasible ? "plan" : "refuse";
    const correct = o.error ? false : o.feasible === o.fixture.expectFeasible;
    const verifierNote =
      o.feasible && !o.allocationOk ? ` · allocation FAILED (${o.violations.length})` : "";
    console.log(
      `  ${correct ? "✓" : "✗"} ${o.fixture.id.padEnd(30)} expected ${expected.padEnd(6)} got ${got.padEnd(6)}${verifierNote}`,
    );
    if (o.error) console.log(`      error: ${o.error}`);
    for (const v of o.violations) console.log(`      ${v}`);
  }
  console.log("");
}

async function main(): Promise<void> {
  const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
  const fixtures = only ? PLAN_FIXTURES.filter((f) => f.id === only) : PLAN_FIXTURES;

  if (fixtures.length === 0) {
    console.error(`No fixture matched "${only}".`);
    process.exit(1);
  }

  console.log(`Running ${fixtures.length} meal-plan fixture(s)…`);

  const outcomes: FixtureOutcome[] = [];
  for (const fixture of fixtures) {
    process.stdout.write(`  ${fixture.id}… `);
    const outcome = await runFixture(fixture);
    const correct = outcome.error ? false : outcome.feasible === fixture.expectFeasible;
    console.log(correct ? "ok" : "MISMATCH");
    outcomes.push(outcome);
  }

  report(outcomes);
}

void main();
