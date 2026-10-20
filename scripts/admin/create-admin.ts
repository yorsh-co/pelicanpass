/**
 * Creates an administrator account.
 *
 * Usage:
 *   docker compose run --rm migrate node scripts/admin/create-admin.ts \
 *     --username joshua --scopes attendees:read,attendees:write
 *
 * `--username` may also be an email address, e.g. `joshua@example.com`.
 *
 * The password is prompted for, twice, and never echoed. It is deliberately not
 * an argv flag: that would put it in shell history and in the process list on a
 * shared host.
 *
 * Connects as the migrator role — the application role holds no `INSERT` on
 * `admins`, by design. See scripts/admin/db.ts.
 */

import { argv, exit } from 'node:process';

import { db } from './db.ts';
import { readPassword } from './prompt.ts';

import {
  ADMIN_SCOPE_VALUES,
  isAdminScope,
} from '../../src/constants/admin-scopes.ts';
import { isAdminUsername } from '../../src/constants/admin-username.ts';
import { hashPassword } from '../../src/modules/admin/admin.password.ts';
import {
  MIN_PASSWORD_LENGTH,
  WEAK_PASSWORDS,
} from '../../src/constants/password.ts';

import type { AdminScope } from '../../src/constants/admin-scopes.ts';

/**
 * Reads a `--flag value` pair from the command line.
 *
 * @param name - Flag name, without the dashes.
 * @returns The value, or `undefined` if the flag is absent.
 */
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);

  if (index === -1) return undefined;

  return argv[index + 1];
};

/**
 * Validates the requested scopes against the same constant the table's `CHECK`
 * is built from.
 *
 * @param raw - Comma-separated scope list.
 * @throws {Error} If any scope is not one this application enforces.
 */
const parseScopes = (raw: string | undefined): AdminScope[] => {
  if (!raw) return [];

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

/**
 * Holds an administrator password to the same bar as a service credential.
 *
 * The rules are imported from config/env.ts rather than restated, so raising
 * the bar in one place raises it everywhere. Unlike `validatePasswordSecurity`
 * there, this runs in every environment: a weak administrator password in
 * development is a habit that ships.
 *
 * @throws {Error} If the password is too short or a known-weak value.
 */
const validatePassword = (password: string): void => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `The password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`,
    );
  }

  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    throw new Error('That password is a known-weak default value');
  }
};

const main = async (): Promise<void> => {
  const username = (flag('username') ?? '').trim().toLowerCase();

  if (!isAdminUsername(username)) {
    throw new Error(
      '--username is required, and must be 3-64 characters of [a-z0-9._-] or an email address',
    );
  }

  const scopes = parseScopes(flag('scopes'));

  const existing = await db.query('SELECT 1 FROM admins WHERE username = $1', [
    username,
  ]);

  if (existing.rowCount) {
    throw new Error(`An administrator named "${username}" already exists`);
  }

  const password = await readPassword('Password: ');
  const confirmation = await readPassword('Confirm password: ');

  if (password !== confirmation) throw new Error('The passwords do not match');

  validatePassword(password);

  const passwordHash = await hashPassword(password);

  const result = await db.query<{ admin_id: string }>(
    `INSERT INTO admins (username, password_hash, admin_scopes)
    VALUES ($1, $2, $3)
    RETURNING admin_id`,
    [username, passwordHash, scopes],
  );

  const created = result.rows[0];

  if (!created) throw new Error('The administrator was not created');

  console.log(`\n✓ Created "${username}" (${created.admin_id})`);
  console.log(
    `  Scopes: ${scopes.length > 0 ? scopes.join(', ') : 'none — grant some with set-admin-scopes.ts'}`,
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
