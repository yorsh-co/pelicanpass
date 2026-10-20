/**
 * Rung rows for the history tests. Not a test file itself, so importing it
 * does not run anyone's tests twice.
 */

import { COLUMNS } from './row.ts';

import type { RungRow } from './row.ts';

const EMPTY = Object.fromEntries(COLUMNS.map((c) => [c, null])) as RungRow;

/** A valid rung on dev-server, shedding off, with the given columns changed. */
export const rung = (changes: Partial<RungRow>): RungRow => ({
  ...EMPTY,
  schema: 1,
  session: 's1',
  host: 'dev-server',
  cpu_model: 'i7-1260P',
  commit: 'aaaaaaa1111111',
  app_tree: 'ttttttt1111111',
  harness_tree: 'hhhhhhh1111111',
  phase: 'raffle',
  ip_mode: 'spread',
  load_shed_enabled: false,
  trusted_ips_set: false,
  overrides_set: false,
  thresholds_passed: true,
  valid: true,
  ...changes,
});
