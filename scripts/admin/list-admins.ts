/**
 * Lists the administrator roster.
 *
 * Usage:
 *   docker compose run --rm migrate node scripts/admin/list-admins.ts
 *
 * Never selects `password_hash`. There is no reason to put a hash on a terminal
 * that may be scrolled back or logged.
 */

import { exit } from 'node:process';

import { db } from './db.ts';

interface AdminListRow {
  username: string;
  admin_scopes: string[];
  is_active: boolean;
  last_login_at: Date | null;
}

const main = async (): Promise<void> => {
  const result = await db.query<AdminListRow>(
    `SELECT username, admin_scopes, is_active, last_login_at
    FROM admins
    ORDER BY username`,
  );

  if (result.rows.length === 0) {
    console.log('No administrators. Create one with create-admin.ts.');
    return;
  }

  for (const row of result.rows) {
    const state = row.is_active ? 'active' : 'DISABLED';
    const seen = row.last_login_at
      ? row.last_login_at.toISOString()
      : 'never signed in';

    console.log(`${row.username}  [${state}]  ${seen}`);
    console.log(
      `  ${row.admin_scopes.length > 0 ? row.admin_scopes.join(', ') : 'no scopes'}\n`,
    );
  }
};

try {
  await main();
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);

  exit(1);
} finally {
  await db.end();
}
