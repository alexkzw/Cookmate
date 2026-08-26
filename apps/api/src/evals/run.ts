import { config } from "../config.js";
import { getFixtures, fixtureSetHash, FIXTURES } from "./fixtures.js";
import { runSuite } from "./runner.js";
import { replaySuite, latestScorableSuite, DuplicateReplayError } from "./replay.js";
import {
  JUDGE_MODEL,
  judgePromptHash,
  judgeRecipe,
  recordJudgement,
  recordHumanLabel,
  unjudgedRows,
  unlabelledRows,
  calibration,
  lengthBias,
  judgeByCondition,
  armNeutrality,
} from "./judge.js";
import { getFixtures as fixturesById } from "./fixtures.js";
import type { Recipe } from "@cookmate/shared";
import { createInterface } from "node:readline/promises";
import {
  summariseByCondition,
  summariseByFixture,
  summariseByKind,
  summariseRepair,
  latestSuiteId,
  unexpectedRuns,
  firstPassFailures,
  promptHash,
  SCORER_HASH,
  type ConditionSummary,
} from "./store.js";
import {
  clusteredWilson,
  compareProportions,
  bonferroniAlpha,
  fmtInterval,
} from "./stats.js";

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
 *   pnpm eval --judge                  score stored recipes for QUALITY (cheap)
 *   pnpm eval --label                  record your own scores, to calibrate it
 *   pnpm eval --judge-report           agreement + length-bias probe
 *
 * Model and effort come from .env, so sweeping a condition is the same
 * workflow as the manual sweep — edit .env, run again, compare.
 */

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  // `--judge --yes` must not read "--yes" as a suite id. Optional-argument
  // flags sit next to boolean ones, so the next token is only a value if it
  // isn't itself a flag.
  return next !== undefined && !next.startsWith("--") ? next : undefined;
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
      repair: c.repair === null ? "?" : c.repair ? "on" : "off",
      prompt: c.prompt_hash,
      fixtures: c.fixture_set_hash,
      scorer: c.scorer_hash ?? "?",
      n: c.n,
      passed: `${c.passed}/${c.n}`,
      // The interval, not the point estimate. A bare "81%" from 36 runs invites
      // a comparison the sample cannot support; "81% [65-91]" does not.
      pass_rate: fmtInterval(clusteredWilson(c.passed, c.n, c.fixtures).optimistic),
      errors: c.errors,
      avg_cost: fmtUsd(c.avg_cost),
      avg_s: (c.avg_latency / 1000).toFixed(1),
    })),
  );

  significance(conditions);

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
        repair: r.repair === null ? "?" : r.repair ? "on" : "off",
        first_pass: `${r.first_pass}/${r.n}`,
        final_pass: `${r.final_pass}/${r.n}`,
        repaired: r.repaired,
        rescued: r.final_pass - r.first_pass,
        total_cost: fmtUsd(r.total_cost),
        cost_per_pass: fmtUsd(r.final_pass > 0 ? r.total_cost / r.final_pass : 0),
      })),
    );

    // With repair on, the final verdict is mostly "pass" — so without this the
    // report shows a healthy system and hides every weakness repair papered
    // over. These are the runs the model got wrong before being told.
    const firstFails = firstPassFailures(suiteId);
    if (firstFails.length > 0) {
      console.log("\nFIRST-PASS FAILURES — what the model got wrong before repair saw it");
      for (const f of firstFails) {
        const tag = f.rescued ? "rescued" : "still failing";
        console.log(`  ${f.fixture_id} #${f.repeat_index + 1} [${f.kinds}] (${tag})`);
        console.log(`      ${f.details || "(detail not recorded — run predates first_pass_verification_json)"}`);
      }
    }
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


const fmtSigned = (n: number) => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2));

/**
 * IS THE DIFFERENCE REAL, OR IS IT THE DICE?
 *
 * Generation is stochastic, so every pass rate here is a sample. Two samples
 * from an UNCHANGED system differ constantly — which means a table of point
 * estimates invites exactly the mistake this section exists to stop: seeing
 * 29/36 next to 26/36 and concluding something improved.
 *
 * Three things get printed and each answers a different question:
 *   the interval        how precisely do I know this arm's rate?
 *   the p-value         could this gap be chance?
 *   the required n      how many runs would settle it, and what would that cost?
 *
 * The third is the one that makes an inconclusive result actionable instead of
 * an invitation to run it again and hope.
 */
function significance(conditions: ConditionSummary[]): void {
  console.log("\nSIGNIFICANCE — is the difference real, or is it the dice?");

  if (conditions.length < 2) {
    console.log("  (one condition — nothing to compare against)");
    // Still worth saying how precisely we know the single rate we have.
    const c = conditions[0];
    if (c) {
      const ci = clusteredWilson(c.passed, c.n, c.fixtures);
      console.log(
        `  ${c.model}/${c.effort}: ${fmtInterval(ci.optimistic)} ` +
          `(clustered by fixture: ${fmtInterval(ci.conservative)})`,
      );
    }
    return;
  }

  // Every pair, because "which arm is best" is a question about all of them.
  const pairs: Array<[ConditionSummary, ConditionSummary]> = [];
  for (let i = 0; i < conditions.length; i += 1)
    for (let j = i + 1; j < conditions.length; j += 1) {
      const a = conditions[i];
      const b = conditions[j];
      if (a && b) pairs.push([a, b]);
    }

  const alpha = bonferroniAlpha(pairs.length);
  const label = (c: ConditionSummary) =>
    `${c.model}/${c.effort} repair:${c.repair ? "on" : "off"} p:${c.prompt_hash}`;

  /**
   * Two rows can describe the SAME arm and still be separate rows: runs made
   * before `scorer_hash` existed fall back to `git:<sha>` for grouping, and
   * that over-splits across commits that never touched the verifier.
   *
   * Those pairs are not comparisons — the model, effort, repair setting and
   * prompt are identical, so there is no treatment. What they measure is
   * RUN-TO-RUN VARIANCE, which makes them the most useful rows in the table:
   * they are an empirical answer to "how much do two identical configurations
   * differ?", and any real effect has to clear that bar. Labelling them REAL or
   * noise alongside genuine comparisons would be reading a control as a result.
   */
  const sameArm = (a: ConditionSummary, b: ConditionSummary): boolean =>
    a.model === b.model &&
    a.effort === b.effort &&
    a.repair === b.repair &&
    a.prompt_hash === b.prompt_hash;

  console.table(
    pairs.map(([a, b]) => {
      const cmp = compareProportions(a.passed, a.n, b.passed, b.n);
      const identical = sameArm(a, b);
      return {
        A: label(a),
        B: label(b),
        A_rate: `${a.passed}/${a.n}`,
        B_rate: `${b.passed}/${b.n}`,
        diff_pts: (cmp.diff * 100).toFixed(1),
        p: cmp.p < 0.001 ? "<0.001" : cmp.p.toFixed(3),
        verdict: identical ? "SAME ARM" : cmp.p < alpha ? "REAL" : "noise",
        // What it would take to settle the ones that came back inconclusive.
        n_needed: identical || cmp.nForObserved === null ? "—" : `${cmp.nForObserved}/arm`,
      };
    }),
  );

  // Run-to-run variance, read straight off the self-comparisons.
  const controls = pairs.filter(([a, b]) => sameArm(a, b));
  if (controls.length > 0) {
    const spreads = controls.map(([a, b]) => Math.abs(a.passed / a.n - b.passed / b.n));
    const worst = Math.max(...spreads);
    console.log(
      `\n  ${controls.length} pair${controls.length === 1 ? "" : "s"} above compare an arm ` +
        `against ITSELF (identical model, effort, repair and prompt).`,
    );
    console.log(
      `  Largest gap between two identical configurations: ${(worst * 100).toFixed(1)} points.`,
    );
    console.log(
      "  Treat that as the noise floor — a change that moves the pass rate by less",
    );
    console.log("  than this has not been shown to do anything at all.");
  }

  console.log(
    `  ${pairs.length} pairwise comparison${pairs.length === 1 ? "" : "s"}, ` +
      `so the threshold is Bonferroni-corrected to alpha = ${alpha.toFixed(4)}.`,
  );
  console.log(
    "  Reading `noise`: the data cannot distinguish these arms. That is not the",
  );
  console.log(
    "  same as saying they are equal — it means this sample is too small to tell,",
  );
  console.log("  and n_needed says how much bigger it would have to be.");

  // The clustering caveat, stated per condition rather than buried in a doc.
  const clustered = conditions.filter((c) => c.fixtures > 0 && c.n > c.fixtures);
  if (clustered.length > 0) {
    console.log("\n  REPEATS ARE NOT INDEPENDENT SAMPLES.");
    console.log(
      "  Three runs of one fixture are three samples of the same question, so the",
    );
    console.log(
      "  true precision sits between these two intervals. Where they disagree, the",
    );
    console.log("  conclusion rests on an assumption the data cannot support.");
    for (const c of clustered) {
      const ci = clusteredWilson(c.passed, c.n, c.fixtures);
      console.log(
        `    ${label(c)}\n` +
          `      assuming independence (n=${c.n}):  ${fmtInterval(ci.optimistic)}\n` +
          `      clustered by fixture (n=${c.fixtures}): ${fmtInterval(ci.conservative)}`,
      );
    }
  }
}

function judgeReport(suiteId?: string): void {
  console.log(`\n=== quality judge · ${JUDGE_MODEL} · prompt ${judgePromptHash()} ===\n`);

  const byCondition = judgeByCondition(suiteId);
  if (byCondition.length === 0) {
    console.log("Nothing judged yet. Run `pnpm eval --judge` first.\n");
    return;
  }

  console.log("QUALITY BY ARM — what the verifier's pass rate cannot tell you");
  console.table(
    byCondition.map((r) => ({
      model: r.model,
      repair: r.repair === null ? "?" : r.repair ? "on" : "off",
      n: r.n,
      appeal: r.appeal.toFixed(2),
      technique: r.technique.toFixed(2),
      clarity: r.clarity.toFixed(2),
      overall: r.overall.toFixed(2),
    })),
  );

  // CALIBRATION — the number that decides whether anything above is meaningful.
  const cal = calibration();
  console.log("\nCALIBRATION — does the judge agree with a human?");
  if (!cal) {
    console.log("  (no human labels yet — run `pnpm eval --label`)");
    console.log("  Until then, treat every score above as unvalidated.");
  } else {
    console.log(`  labelled            : ${cal.n}`);
    console.log(`  exact agreement     : ${cal.exact}/${cal.n} (${pct(cal.exact / cal.n)})`);
    console.log(`  within 1 point      : ${cal.within1}/${cal.n} (${pct(cal.within1 / cal.n)})`);
    console.log(`  mean absolute error : ${cal.meanAbsError.toFixed(2)} points`);
    console.log(`  judge mean          : ${cal.judgeMean.toFixed(2)}`);
    console.log(`  human mean          : ${cal.humanMean.toFixed(2)}  (bias ${fmtSigned(cal.judgeMean - cal.humanMean)})`);
    console.log(`  correlation         : ${cal.correlation === null ? "n/a" : cal.correlation.toFixed(2)}`);
    if (cal.n < 10) console.log(`  NOTE: ${cal.n} labels is too few to conclude much. Aim for 15.`);
    else if (cal.meanAbsError > 1) console.log("  WARNING: the judge is off by more than a point on average. Don't quote its scores.");
  }

  // ARM NEUTRALITY — does the judge's error differ BETWEEN arms?
  const arms = armNeutrality();
  console.log("\nARM NEUTRALITY — is the judge fair across generating models?");
  if (arms.length < 2) {
    console.log("  (only one arm judged — judge more than one to compare)");
  } else {
    console.table(
      arms.map((a) => ({
        model: a.model,
        repair: a.repair === null ? "?" : a.repair ? "on" : "off",
        judged: a.judged,
        judge_mean: a.judgeMean.toFixed(2),
        labelled: a.labelled,
        human_mean: a.humanMean === null ? "—" : a.humanMean.toFixed(2),
        bias: a.bias === null ? "—" : fmtSigned(a.bias),
      })),
    );
    const withBias = arms.filter((a) => a.bias !== null && a.labelled >= 3);
    if (withBias.length < 2) {
      console.log("  Label recipes from BOTH arms to read this — bias needs human anchors on each.");
    } else {
      const spread =
        Math.max(...withBias.map((a) => a.bias as number)) -
        Math.min(...withBias.map((a) => a.bias as number));
      console.log(`  bias spread between arms : ${spread.toFixed(2)} points`);
      console.log(
        spread > 0.5
          ? "  WARNING: the judge is off by different amounts per arm — it is not arm-neutral,\n" +
            "  so any arm comparison drawn from its scores is contaminated."
          : "  Bias is consistent across arms, so a difference in judge_mean reflects the\n" +
            "  recipes rather than the judge's taste for a particular model.",
      );
    }
  }

  // LENGTH BIAS — the best-documented judge failure, and the easiest to test.
  const bias = lengthBias(suiteId);
  console.log("\nLENGTH-BIAS PROBE — is the judge rewarding verbosity?");
  if (!bias) {
    console.log("  (not enough judged rows with token counts)");
  } else {
    console.log(`  n                   : ${bias.n}`);
    console.log(`  score vs output_tokens correlation : ${bias.correlation === null ? "n/a" : bias.correlation.toFixed(2)}`);
    console.log(`  shorter than median (${bias.medianTokens} tok) : ${bias.shortMean.toFixed(2)}`);
    console.log(`  longer  than median             : ${bias.longMean.toFixed(2)}`);
    const gap = bias.longMean - bias.shortMean;
    console.log(`  gap                 : ${fmtSigned(gap)}`);
    if (bias.correlation !== null && bias.correlation > 0.4) {
      console.log("  WARNING: strong positive correlation — the judge is partly grading length.");
    } else {
      console.log("  No strong length effect. (Not proof — longer recipes may genuinely be better.)");
    }
  }
  console.log();
}

async function runJudge(suiteId: string | undefined, yes: boolean): Promise<void> {
  const rows = unjudgedRows(suiteId);
  if (rows.length === 0) {
    console.log("\nEverything is already judged by this model and prompt.\n");
    return judgeReport(suiteId);
  }

  // Judging re-reads stored recipes, so it never asks the model to generate —
  // the only cost is the judge itself, on the cheapest tier.
  console.log(
    `\n${rows.length} stored recipes to judge · ${JUDGE_MODEL} · prompt ${judgePromptHash()}\n` +
      `estimated cost ≈ ${fmtUsd(rows.length * 0.0015)} (no generations — stored recipes only)\n`,
  );
  if (!yes) {
    console.log("Add --yes to run. Nothing has been spent.\n");
    return;
  }

  let spent = 0;
  let done = 0;
  for (const row of rows) {
    done += 1;
    const fixture = fixturesById([row.fixture_id])[0];
    if (!fixture) {
      console.log(`[${done}/${rows.length}] ${row.fixture_id} — fixture gone, skipped`);
      continue;
    }
    try {
      const recipe = JSON.parse(row.recipe_json) as Recipe;
      const verdict = await judgeRecipe(recipe, fixture.request);
      recordJudgement(row.id, verdict);
      spent += verdict.costUsd;
      console.log(
        `[${done}/${rows.length}] ${row.fixture_id} #${row.repeat_index + 1}  ` +
          `overall ${verdict.overall.toFixed(2)} ` +
          `(a${verdict.appeal} t${verdict.technique} c${verdict.clarity})  ${verdict.reason}`,
      );
    } catch (err) {
      console.log(`[${done}/${rows.length}] ${row.fixture_id} ERROR: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\ndone · ${fmtUsd(spent)} spent\n`);
  judgeReport(suiteId);
}

/**
 * Record your own scores.
 *
 * You grade blind on purpose: the judge's score for the recipe in front of you
 * is never shown. Seeing it first would anchor you, and the agreement number
 * would then be measuring your suggestibility rather than the judge's accuracy.
 */
async function runLabel(): Promise<void> {
  const rows = unlabelledRows();
  if (rows.length === 0) {
    console.log("\nNothing left to label. Run `pnpm eval --judge` first, or you're done.\n");
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(
    `\n${rows.length} recipes to grade. 1–5 for overall quality, blank to skip, q to stop.\n` +
      `  1 = wouldn't cook it   3 = fine   5 = would recommend without qualification\n` +
      `You are NOT checking achievability — the verifier already does that.\n`,
  );

  let labelled = 0;
  for (const row of rows) {
    const recipe = JSON.parse(row.recipe_json) as Recipe;
    console.log(`\n${"─".repeat(64)}`);
    console.log(`${row.fixture_id} #${row.repeat_index + 1} — ${recipe.title}`);
    console.log(recipe.summary);
    console.log(`\ningredients: ${recipe.ingredients.map((i) => i.name).join(", ")}`);
    console.log("steps:");
    for (const step of recipe.steps) {
      console.log(`  ${step.number}. ${step.instruction} (${step.minutes}m${step.handsOff ? ", hands-off" : ""})`);
    }
    if (recipe.tips.length > 0) console.log(`tips: ${recipe.tips.join(" · ")}`);

    const answer = (await rl.question("\nyour score (1-5): ")).trim().toLowerCase();
    if (answer === "q") break;
    if (answer === "") continue;

    const score = Number(answer);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      console.log("  not 1-5 — skipped");
      continue;
    }
    recordHumanLabel(row.id, score);
    labelled += 1;
  }

  rl.close();
  console.log(`\nrecorded ${labelled} label(s).\n`);
  if (labelled > 0) judgeReport();
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

  if (flag("judge-report")) {
    judgeReport(flag("all") ? undefined : latestSuiteId());
    return;
  }

  if (flag("label")) {
    await runLabel();
    return;
  }

  if (flag("judge")) {
    await runJudge(flag("all") ? undefined : (value("judge") ?? latestScorableSuite()), flag("yes"));
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
      `prompt ${promptHash()} · fixtures ${fixtureSetHash(fixtures)} · scorer ${SCORER_HASH}\n` +
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
