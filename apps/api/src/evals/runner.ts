import { randomUUID } from "node:crypto";
import { verifyRecipe } from "../verify/constraints.js";
import { streamRecipe, RecipeGenerationError } from "../llm/generate.js";
import { config } from "../config.js";
import { recordRun, promptHash } from "./store.js";
import type { Fixture } from "./fixtures.js";

/**
 * The suite runner.
 *
 * It calls `streamRecipe` + `verifyRecipe` directly rather than going through
 * POST /api/chat/stream. That's deliberate: this measures the *model and the
 * prompt*, not the HTTP wiring. Driving it through the route would mean auth,
 * SSE parsing, and writing each fixture's pantry into the database first — all
 * of which can fail for reasons that have nothing to do with recipe quality.
 *
 * Runs are sequential on purpose. Parallel calls would race the prompt cache
 * (several writes of the same prefix instead of one write and N reads) and
 * distort the cost numbers this suite exists to produce.
 */

export interface SuiteOptions {
  fixtures: Fixture[];
  repeats: number;
  /** Print progress as it goes — a 20-minute silent run is unnerving. */
  onProgress?: (line: string) => void;
}

export interface SuiteResult {
  suiteId: string;
  runs: number;
  failures: number;
  errors: number;
  costUsd: number;
}

export async function runSuite(opts: SuiteOptions): Promise<SuiteResult> {
  const suiteId = randomUUID().slice(0, 8);
  const log = opts.onProgress ?? (() => {});

  const total = opts.fixtures.length * opts.repeats;
  let done = 0;
  let failures = 0;
  let errors = 0;
  let costUsd = 0;

  log(
    `suite ${suiteId} · ${opts.fixtures.length} fixtures × ${opts.repeats} ` +
      `= ${total} runs · ${config.RECIPE_MODEL} / ${config.RECIPE_EFFORT} · prompt ${promptHash()}`,
  );

  for (const fixture of opts.fixtures) {
    for (let i = 0; i < opts.repeats; i += 1) {
      done += 1;
      const label = `[${done}/${total}] ${fixture.id} #${i + 1}`;

      try {
        // The delta callback is a no-op: nothing is watching tokens arrive.
        const { recipe, usage } = await streamRecipe(fixture.request, () => {});
        const verification = verifyRecipe(recipe, fixture.request);

        costUsd += usage.costUsd;
        if (!verification.ok) failures += 1;

        recordRun({
          id: randomUUID(),
          suiteId,
          fixtureId: fixture.id,
          repeatIndex: i,
          usage,
          verification,
          recipeTitle: recipe.title,
          recipeJson: JSON.stringify(recipe),
        });

        const verdict = verification.ok
          ? "pass"
          : `FAIL ${verification.violations.map((v) => v.kind).join(",")}`;
        log(
          `${label}  ${verdict}  $${usage.costUsd.toFixed(4)}  ` +
            `${(usage.latencyMs / 1000).toFixed(1)}s  ${usage.cacheStatus}`,
        );
      } catch (err) {
        // One truncation must not abandon a twenty-minute suite. Record it as a
        // result — an error rate is a finding, not an interruption.
        errors += 1;
        const code = err instanceof RecipeGenerationError ? err.code : "internal_error";
        const usage = err instanceof RecipeGenerationError ? err.usage : undefined;
        if (usage) costUsd += usage.costUsd;

        recordRun({
          id: randomUUID(),
          suiteId,
          fixtureId: fixture.id,
          repeatIndex: i,
          usage,
          errorCode: code,
          model: config.RECIPE_MODEL,
          effort: config.RECIPE_EFFORT,
        });

        log(`${label}  ERROR ${code}`);
      }
    }
  }

  return { suiteId, runs: total, failures, errors, costUsd };
}
