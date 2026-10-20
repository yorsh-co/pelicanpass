/**
 * Sets an administrator's password.
 *
 * Usage:
 *   docker compose run --rm migrate node scripts/admin/set-admin-password.ts \
 *     --username joshua
 *
 * This is the reset path, and it is also the **recovery path after an
 * `ADMIN_PASSWORD_PEPPER` rotation**: a hash produced under the old pepper can
 * no longer be verified, and nothing can re-derive it without the plaintext, so
 * every account has to be given a new password by hand. That is the cost the
 * pepper buys, and it is why the secret is listed as backup-critical in
 * docs/operations/deployment.md.
 */

import { argv, exit } from 'node:process';

import { db } from './db.ts';
import { readPassword } from './prompt.ts';

import { hashPassword } from '../../src/modules/admin/admin.password.ts';
import {
  MIN_PASSWORD_LENGTH,
  WEAK_PASSWORDS,
} from '../../src/constants/password.ts';

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

/**
 * Holds the password to the same bar as a service credential.
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

  if (!username) throw new Error('--username is required');

  const existing = await db.query('SELECT 1 FROM admins WHERE username = $1', [
    username,
  ]);

  if (!existing.rowCount) {
    throw new Error(`No administrator named "${username}"`);
  }

  const password = await readPassword('New password: ');
  const confirmation = await readPassword('Confirm password: ');

  if (password !== confirmation) throw new Error('The passwords do not match');

  validatePassword(password);

  const passwordHash = await hashPassword(password);

  await db.query(
    `UPDATE admins
      SET password_hash = $2,
        password_changed_at = now(),
        updated_at = now()
    WHERE username = $1`,
    [username, passwordHash],
  );

  console.log(`\n✓ Password set for "${username}"`);
};

try {
  await main();
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);

  exit(1);
} finally {
  await db.end();
}
