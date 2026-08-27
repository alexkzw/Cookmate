import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * A content hash of the SCORER — the code that decides whether a recipe passed.
 *
 * Lives beside the verifier rather than in the eval harness because BOTH sides
 * record it now: eval rows have carried it since it shipped, and production
 * turns record it too. Keeping it here means `telemetry/turns.ts` does not have
 * to import from `evals/`, which would drag the eval table definitions and
 * their backfill statements into the boot path of the production API for the
 * sake of one constant.
 *
 * WHY A CONTENT HASH AND NOT `git_sha`.
 * git_sha answers "which commit" when the question is "which scorer", and those
 * come apart constantly: the three-arm comparison in CLAUDE.md ran across two
 * commits whose diff touched only the repair loop and the eval harness, never
 * the verifier. git_sha correctly refused to call those arms identical and was
 * correctly ignored — a sign the key was measuring the wrong thing.
 *
 * Equal hash means every run was graded by byte-identical logic. A differing
 * hash means the metric moved under you, which is the one thing a pass rate
 * cannot tell you about itself.
 *
 * Reads source rather than importing, deliberately: the taxonomy is data, and a
 * hash over `JSON.stringify(TAXONOMY)` would miss a changed predicate. A hash
 * over a module's behaviour is not something you can take.
 */
const SCORER_SOURCES = [
  "apps/api/src/verify/constraints.ts", // the checks
  "apps/api/src/verify/resolve.ts", // lemmatise -> taxonomy -> lexical fallback
  "packages/shared/src/ingredients.ts", // the canonical taxonomy the checks consult
  "packages/shared/src/constraints.ts", // Verification + the violation kinds
];

function scorerHash(): string {
  /**
   * In a production image the scorer SOURCES ARE NOT SHIPPED — the runtime
   * stage carries compiled JS only, deliberately, so there is nothing to hash.
   * The build stamps the hash it computed into the image instead, which is
   * strictly better: it records the scorer that produced this artifact rather
   * than re-deriving it from whatever happens to be on disk.
   *
   * Same idea as GIT_SHA. Provenance belongs to the build, not the runtime.
   */
  const baked = process.env.SCORER_HASH;
  if (baked && baked.length > 0) return baked;

  // .../apps/api/src/verify -> repo root
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const h = createHash("sha256");
  try {
    for (const rel of SCORER_SOURCES) {
      h.update(rel); // a renamed file must move the hash even if its bytes don't
      h.update(readFileSync(join(repoRoot, rel), "utf8"));
    }
  } catch {
    // Running from a build output where the sources aren't shipped. Better to
    // say so than to emit a hash of nothing that compares equal to everything.
    return "unknown";
  }
  return h.digest("hex").slice(0, 8);
}

export const SCORER_HASH = scorerHash();
