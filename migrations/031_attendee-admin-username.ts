import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Adds the administrator account a volunteer signs in to `/admin` with, so the
 * pass can tell which volunteers also hold one.
 *
 * **A label, not a permission.** It names an account; it grants nothing. Every
 * admin gate still authenticates against `admins` with its own login and its
 * own session cookie, and re-reads Postgres on each request, so an attendee row
 * naming an administrator never stands in for either.
 *
 * A column on the attendee rather than a link from `admins`, for the reason
 * `022_attendee-admin-link.ts` gives: administrators are deliberately not
 * event-scoped (see `013_admins.ts`), and the roster is purged per event. There
 * is no foreign key for the same reason, and the import validates that the
 * account exists when it is set. A username that later matches no account, or
 * one that is disabled, resolves to "no admin access", which fails safe.
 *
 * Nullable, with `NULL` meaning "no administrator account". The length check
 * mirrors `admins_username_length_check` in 013. `SELECT` without `UPDATE`,
 * like the flags in 008, 010, 011 and 022: it is set as the migrator role by
 * `scripts/db/set-volunteer-permissions.ts` or in `psql`, never through the
 * application.
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
    admin_username: {
      type: 'text',
      check: 'char_length(admin_username) BETWEEN 3 AND 64',
    },
  });

  pgm.sql(`GRANT SELECT (admin_username) ON attendees TO ${role}`);
};

export const down = (pgm: MigrationBuilder): void => {
  // Column privileges and checks are dropped with the column, so there is
  // nothing to revoke first.
  pgm.dropColumn('attendees', 'admin_username');
};
