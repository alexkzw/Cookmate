import { config } from "../config.js";
import { getFixtures, fixtureSetHash, FIXTURES } from "./fixtures.js";
import { runSuite } from "./runner.js";
import { replaySuite, latestScorableSuite, DuplicateReplayError } from "./replay.js";
import {
  summariseByCondition,
  summariseByFixture,
  summariseByKind,
  summariseRepair,
  latestSuiteId,
  unexpectedRuns,
  promptHash,
} from "./store.js";

/**
 * CLI for the eval suite.
 *
 *   pnpm eval                          run every fixture once
 *   pnpm eval --repeats 3              three runs per fixture
 *   pnpm eval --repair                 retry once when verification fails
 *   pnpm eval --only tight-time        just one case
 *   pnpm eval --replay                 re-score the last suite's stored recipes
 *   pnpm eval --replay <suiteId>       re-score a specific suite
 *   pnpm eval --replay --force         re-score even if an identical replay exists
 *   pnpm eval --report                 print the last suite, spend nothing
 *   pnpm eval --report --all           print every run ever recorded
 *   pnpm eval --yes                    skip the cost confirmation
 *
 * Model and effort come from .env, so sweeping a condition is the same
 * workflow as the manual sweep — edit .env, run again, compare.
 */

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const fmtUsd = (n: number) => `$${n.toFixed(4)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function report(suiteId?: string): void {
  const scope = suiteId ? `suite ${suiteId}` : "all recorded runs";
  console.log(`\n=== eval report · ${scope} ===\n`);

  const conditions = summariseByCondition(suiteId);
  if (conditions.length === 0) {
    console.log("No eval runs recorded yet. Run `pnpm eval` first.\n");
    return;
  }

  console.log("BY CONDITION");
  console.table(
    conditions.map((c) => ({
      condition: `${c.model} / ${c.effort}`,
      prompt: c.prompt_hash,
      fixtures: c.fixture_set_hash,
      git: c.git_sha,
      n: c.n,
      passed: `${c.passed}/${c.n}`,
      pass_rate: pct(c.pass_rate),
      errors: c.errors,
      avg_cost: fmtUsd(c.avg_cost),
      avg_s: (c.avg_latency / 1000).toFixed(1),
    })),
  );

  const kinds = summariseByKind(suiteId);
  console.log("\nBY VIOLATION KIND — what actually broke");
  if (kinds.length === 0) console.log("  (no violations recorded)");
  else console.table(kinds);

  const expected = new Map(FIXTURES.map((f) => [f.id, f.expect.ok]));
  const unexpected = unexpectedRuns(suiteId, expected);
  console.log("\nUNEXPECTED OUTCOMES — every fixture here is satisfiable, so these are defects");
  if (unexpected.length === 0) console.log("  (none — every run matched its expectation)");
  else
    for (const u of unexpected)
      console.log(`  ${u.fixture_id} #${u.repeat_index + 1}: ${u.error_code ?? u.details ?? "failed"}`);

  const repair = summariseRepair(suiteId).filter((r) => r.first_pass !== r.n || r.repaired > 0);
  if (repair.length > 0) {
    console.log("\nREPAIR LOOP — first-pass vs final, and what the retries cost");
    console.table(
      repair.map((r) => ({
        model: r.model,
        first_pass: `${r.first_pass}/${r.n}`,
        final_pass: `${r.final_pass}/${r.n}`,
        repaired: r.repaired,
        rescued: r.final_pass - r.first_pass,
        total_cost: fmtUsd(r.total_cost),
        cost_per_pass: fmtUsd(r.final_pass > 0 ? r.total_cost / r.final_pass : 0),
      })),
    );
  }

  console.log("\nBY FIXTURE — which cases carry the failure rate");
  console.table(
    summariseByFixture(suiteId).map((f) => ({
      fixture: f.fixture_id,
      passed: `${f.passed}/${f.n}`,
      kinds: f.kinds ?? "",
    })),
  );
  console.log();
}

async function main(): Promise<void> {
  // Re-score stored recipes under the current verifier. Costs nothing: the
  // generations already happened, and only the scorer changed.
  if (flag("replay")) {
    const source = value("replay") ?? latestScorableSuite();
    if (!source) throw new Error("No suite with stored recipes to re-score.");

    let r;
    try {
      r = replaySuite(source, flag("force"));
    } catch (err) {
      if (err instanceof DuplicateReplayError) {
        console.log(`\n${err.message}`);
        console.log(`Nothing re-scored — the result would be byte-identical.\n`);
        console.log(`  see it:    pnpm eval --report ${err.existingSuiteId}`);
        console.log(`  override:  pnpm eval --replay ${source} --force\n`);
        return;
      }
      throw err;
    }
    console.log(
      `\nre-scored ${r.scored} stored recipes from suite ${r.sourceSuiteId} ` +
        `-> new suite ${r.suiteId}\n` +
        `  prompt ${promptHash()} · fixtures ${fixtureSetHash()} · $0.00 spent\n`,
    );
    if (r.skipped > 0) console.log(`  skipped ${r.skipped} run(s) whose fixture no longer exists`);
    if (r.fixtureDrift)
      console.log("  WARNING: fixtures changed since generation — comparison is not like-for-like\n");

    console.log(`  passed before : ${r.passedBefore}/${r.scored}`);
    console.log(`  passed after  : ${r.passedAfter}/${r.scored}`);
    console.log(`  verdicts changed : ${r.changes.length}`);
    for (const c of r.changes)
      console.log(`    ${c.fixtureId} #${c.repeatIndex + 1}: ${c.was} -> ${c.now}`);

    report(r.suiteId);
    return;
  }

  if (flag("report")) {
    report(flag("all") ? undefined : latestSuiteId());
    return;
  }

  const only = value("only");
  const fixtures = getFixtures(only ? only.split(",").map((s) => s.trim()) : undefined);
  const repeats = Number(value("repeats") ?? 1);
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new Error(`--repeats must be a positive integer, got "${value("repeats")}"`);
  }

  const runs = fixtures.length * repeats;
  // Rough, from the manual sweep: ~$0.07 an Opus turn, ~$0.045 on Sonnet.
  const perRun = config.RECIPE_MODEL.includes("opus") ? 0.07 : 0.045;

  console.log(
    `\n${runs} live generations · ${config.RECIPE_MODEL} / ${config.RECIPE_EFFORT} · ` +
      `prompt ${promptHash()} · fixtures ${fixtureSetHash(fixtures)}\n` +
      `estimated cost ≈ ${fmtUsd(runs * perRun)}${flag("repair") ? " (+ up to ~40% if repairs fire)" : ""}` +
      ` · estimated time ≈ ${Math.ceil((runs * 26) / 60)} min\n` +
      `repair loop: ${flag("repair") ? "ON" : "off (baseline)"}\n`,
  );

  // Live generations cost real money, and a mistyped --repeats is an easy way
  // to spend twenty dollars by accident.
  if (!flag("yes")) {
    console.log("Add --yes to run. Nothing has been spent.\n");
    return;
  }

  const started = Date.now();
  const result = await runSuite({
    fixtures,
    repeats,
    repair: flag("repair"),
    onProgress: (line) => console.log(line),
  });

  console.log(
    `\ndone in ${Math.round((Date.now() - started) / 1000)}s · ` +
      `${result.runs - result.failures - result.errors}/${result.runs} passed · ` +
      `${result.errors} errors · ${fmtUsd(result.costUsd)} spent`,
  );
  report(result.suiteId);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

// Re-exported so `--only` typos can suggest the real ids.
export { FIXTURES };
