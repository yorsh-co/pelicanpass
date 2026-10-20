import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Adds the display name an attendee chooses for their own pass.
 *
 * Nullable with no default: the column is opt-in, and `NULL` is what makes the
 * pass fall back to the first name of the registered `attendee_name`. Clearing
 * a nickname writes `NULL` rather than an empty string, so there is one
 * representation of "not set" rather than two.
 *
 * `varchar(32)` against an application limit of 24 code points. Postgres counts
 * characters, and the value is NFC-normalised before it is written, so the
 * column is headroom rather than the enforcement point — see
 * `src/constants/nickname.ts`, which is where the shape is actually decided.
 *
 * **The grants are the load-bearing half of this migration.**
 * `005_app-role-grants.ts` revoked everything and granted per column, so a new
 * column is invisible to the application until it is named here. A missing
 * grant surfaces as a 500 the first time a real query runs and nowhere earlier.
 * Grants are additive, so these extend that migration's lists rather than
 * replacing them; `\dp attendees` is the authority if the two ever read as
 * contradictory.
 *
 * The `attendees_set_updated_at` trigger from 006 stamps `updated_at` on this
 * write, which is why the repository's `UPDATE` does not set it by hand.
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
    attendee_nickname: { type: 'varchar(32)' },
  });

  pgm.sql(`GRANT SELECT (attendee_nickname) ON attendees TO ${role}`);
  pgm.sql(`GRANT UPDATE (attendee_nickname) ON attendees TO ${role}`);
};

export const down = (pgm: MigrationBuilder): void => {
  // Column privileges are dropped with the column, so there is nothing to
  // revoke first.
  pgm.dropColumn('attendees', 'attendee_nickname');
};
