import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Adds the flag that decides which volunteers may run the raffle draw.
 *
 * A second flag rather than a widening of `can_redeem`: the two jobs are done
 * by different people. Counter staff hand out t-shirts for four hours; the
 * draw is run once, from a stage, by whoever is holding the microphone.
 * Sharing one flag would mean every redeemer could call numbers, which is the
 * opposite of the "specific authorized users" this surface is for.
 *
 * `NOT NULL DEFAULT false` and `SELECT` without `UPDATE`, for the same reasons
 * `008_staff-redeem-permission.ts` gives: there is no third state between
 * permitted and not, the roster import cannot create a draw operator by
 * omission, and nothing in the application ever sets it — promotion is a
 * `psql` act as the migrator role, which is what stops a compromised
 * application session from promoting itself.
 *
 * The flag is re-read on every request against the raffle surface rather than
 * baked into the session, so standing someone down mid-event takes effect on
 * their next tap instead of waiting out the 24-hour attendee TTL.
 *
 * **The grant is the load-bearing half of this migration.**
 * `005_app-role-grants.ts` revoked everything and granted per column, so a new
 * column is invisible to the application until it is named here, and a missing
 * grant surfaces as a 500 the first time a real query runs and nowhere earlier.
 *
 * There is deliberately no admin surface for this, the same gap `008` records.
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
    can_draw: { type: 'boolean', notNull: true, default: false },
  });

  pgm.sql(`GRANT SELECT (can_draw) ON attendees TO ${role}`);
};

export const down = (pgm: MigrationBuilder): void => {
  // Column privileges are dropped with the column, so there is nothing to
  // revoke first.
  pgm.dropColumn('attendees', 'can_draw');
};
