/**
 * Identifies the app a rung ran: what goes into the image, not the commit.
 *
 * A docs-only commit changes the commit hash and nothing the load test
 * measures, so grouping by commit would split one version of the app across
 * sessions. `app_tree` hashes only the paths that change what runs.
 * `harness_tree` does the same for the scenarios k6 runs, so committing a
 * session's history does not read as a new harness.
 */

import { createHash } from 'node:crypto';

/**
 * Paths that decide what the load-test stack runs: the app and its
 * dependencies, the image, Postgres's roles and tuning, and the overrides
 * `compose.loadtest.yml` applies.
 */
export const APP_PATHS = [
  'src',
  'migrations',
  'scripts/db/init',
  'package.json',
  'package-lock.json',
  'Dockerfile',
  '.dockerignore',
  'compose.prod.yml',
  'compose.loadtest.yml',
] as const;

/**
 * Paths that decide what k6 runs. `loadtest/history/` stays out: the runner
 * appends to it, and `loadtest/results/` and the fixtures are not committed.
 */
export const HARNESS_PATHS = ['loadtest/run.ts', 'loadtest/lib'] as const;

/**
 * Hashes a committed tree together with any uncommitted change to it, so two
 * dirty runs group only when they carry the same change.
 *
 * @param lsTree - `git ls-tree HEAD -- <paths>`: one object hash per path.
 * @param diff - `git diff HEAD -- <paths>`; empty for a clean tree.
 * @returns A 40-character hex digest.
 */
export const appTreeHash = (lsTree: string, diff: string): string =>
  createHash('sha1').update(lsTree).update('\0').update(diff).digest('hex');
