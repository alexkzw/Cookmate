import { rmSync } from "node:fs";

/**
 * Start every test run from an empty database.
 *
 * Runs before any test file is imported, which matters: `db/index.ts` opens the
 * file and runs migrations at module scope, so deleting it from a `beforeAll`
 * would be too late. The path is overridden in vitest.config.ts — the tests must
 * never be able to touch the dev database, and least of all the cost-cap tests,
 * which assert on how much has been spent.
 */
export default function setup(): void {
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(`./data/test-cookmate.db${suffix}`, { force: true });
  }
}
