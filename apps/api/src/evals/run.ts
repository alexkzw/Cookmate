import { config } from "../config.js";
import { getFixtures, FIXTURES } from "./fixtures.js";
import { runSuite } from "./runner.js";
import {
  summariseByCondition,
  summariseByFixture,
  summariseByKind,
  latestSuiteId,
  promptHash,
} from "./store.js";

/**
 * CLI for the eval suite.
 *
 *   pnpm eval                          run every fixture once
 *   pnpm eval --repeats 3              three runs per fixture
 *   pnpm eval --only tight-time        just one case
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
      `prompt ${promptHash()}\n` +
      `estimated cost ≈ ${fmtUsd(runs * perRun)} · estimated time ≈ ${Math.ceil((runs * 26) / 60)} min\n`,
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
