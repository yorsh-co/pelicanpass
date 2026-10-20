/**
 * Replaces an administrator's scopes, or enables and disables the account.
 *
 * Usage:
 *   docker compose run --rm migrate node scripts/admin/set-admin-scopes.ts \
 *     --username joshua --scopes attendees:read
 *
 *   docker compose run --rm migrate node scripts/admin/set-admin-scopes.ts \
 *     --username joshua --disable
 *
 * Scopes are **replaced**, not merged: narrowing someone has to be as easy as
 * widening them, and a merge-only tool makes the safe direction the harder one.
 * Pass `--scopes ''` to strip them all.
 *
 * Both take effect on the administrator's next request — the gates re-read
 * Postgres rather than trusting the session — so there is no session to expire
 * and nobody to sign out.
 */

import { argv, exit } from 'node:process';

import { db } from './db.ts';

import {
  ADMIN_SCOPE_VALUES,
  isAdminScope,
} from '../../src/constants/admin-scopes.ts';

import type { AdminScope } from '../../src/constants/admin-scopes.ts';

/**
 * Reads a `--flag value` pair from the command line.
 *
 * @param name - Flag name, without the dashes.
 */
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);

  if (index === -1) return undefined;

  return argv[index + 1];
};

const has = (name: string): boolean => argv.includes(`--${name}`);

/**
 * Validates the requested scopes against the constant the `CHECK` is built
 * from.
 *
 * @param raw - Comma-separated scope list.
 * @throws {Error} If any scope is not one this application enforces.
 */
const parseScopes = (raw: string): AdminScope[] => {
  const scopes = raw
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);

  const unknown = scopes.filter((scope) => !isAdminScope(scope));

  if (unknown.length > 0) {
    throw new Error(
      `Unknown scope(s): ${unknown.join(', ')}\nValid scopes: ${ADMIN_SCOPE_VALUES.join(', ')}`,
    );
  }

  return [...new Set(scopes as AdminScope[])];
};

const main = async (): Promise<void> => {
  const username = (flag('username') ?? '').trim().toLowerCase();

  if (!username) throw new Error('--username is required');

  const disable = has('disable');
  const enable = has('enable');
  const rawScopes = flag('scopes');

  if (disable && enable) {
    throw new Error('Pass either --enable or --disable, not both');
  }

  if (!disable && !enable && rawScopes === undefined) {
    throw new Error('Nothing to do: pass --scopes, --enable or --disable');
  }

  // Built as a set of assignments so one statement covers every combination,
  // rather than issuing an UPDATE per flag and leaving the account briefly in a
  // state neither command intended.
  const assignments: string[] = [];
  const values: unknown[] = [username];

  if (rawScopes !== undefined) {
    values.push(parseScopes(rawScopes));
    assignments.push(`admin_scopes = $${String(values.length)}`);
  }

  if (disable || enable) {
    values.push(enable);
    assignments.push(`is_active = $${String(values.length)}`);
  }

  assignments.push('updated_at = now()');

  const result = await db.query<{ username: string; admin_scopes: string[] }>(
    `UPDATE admins
      SET ${assignments.join(', ')}
    WHERE username = $1
    RETURNING username, admin_scopes, is_active`,
    values,
  );

  const updated = result.rows[0];

  if (!updated) throw new Error(`No administrator named "${username}"`);

  console.log(`\n✓ Updated "${updated.username}"`);
  console.log(
    `  Scopes: ${updated.admin_scopes.length > 0 ? updated.admin_scopes.join(', ') : 'none'}`,
  );
};

try {
  await main();
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);

  exit(1);
} finally {
  await db.end();
}
