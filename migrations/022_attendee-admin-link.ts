import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Adds the flag that puts a link to `/admin` on a volunteer's pass.
 *
 * **A hint, not a permission.** Some volunteers also hold an administrator
 * account, and this saves them typing the address. It grants nothing: `/admin`
 * authenticates against `admins` with its own login and its own session
 * cookie, and an attendee session never stands in for either. Nothing in the
 * request path reads this column except the pass render.
 *
 * A flag on the attendee rather than a link from `admins` to `attendees`:
 * administrators are deliberately not event-scoped (see `013_admins.ts`), and
 * joining them to an event-scoped roster would re-create that link every time
 * the roster is purged. The cost is drift — an administrator whose account is
 * disabled keeps the link until the flag is cleared, and the link then leads to
 * a login they can no longer pass.
 *
 * `NOT NULL DEFAULT false` and `SELECT` without `UPDATE`, like the permission
 * flags in 008, 010 and 011: the roster import cannot set it by omission, and it
 * is set as the migrator role by `scripts/db/set-volunteer-permissions.ts` or in
 * `psql`, never through the application.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Reads the application role name from the environment.
 *
 * Duplicated from `005_app-role-grants.ts` rather than imported: a migration is
 * a snapshot that has to keep running unchanged, so it does not depend on
 * another migration's internals.
 *
 * @returns The validated role name.
 * @throws {Error} If the variable is unset or is not a bare identifier.
 */
const appRole = (): string => {
  const role = process.env.POSTGRES_USER;

  if (!role) {
    throw new Error(
      'POSTGRES_USER must be set: it names the role these grants apply to',
    );
  }

  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`POSTGRES_USER is not a bare SQL identifier: ${role}`);
  }

  return role;
};

export const up = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.addColumn('attendees', {
    show_admin_link: { type: 'boolean', notNull: true, default: false },
  });

  pgm.sql(`GRANT SELECT (show_admin_link) ON attendees TO ${role}`);
};

export const down = (pgm: MigrationBuilder): void => {
  // Column privileges are dropped with the column, so there is nothing to
  // revoke first.
  pgm.dropColumn('attendees', 'show_admin_link');
};
