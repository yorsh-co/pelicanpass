import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Adds the timestamp that retires an attendee without deleting them.
 *
 * The attendees editor needs a way to take a duplicate registration, a
 * cancellation or a mistaken row out of the event. Deleting is not it: the
 * schema carries no foreign keys, so a delete silently orphans the
 * `redemptions` and `raffle_draws` rows pointing at that attendee, and
 * `checkin_number` comes from a sequence — `scripts/db/purge-attendees.sql`
 * already redacts rather than deletes for exactly that reason, because gaps
 * "look like data loss and would break any downstream count".
 *
 * **This is a real disable, not a listing filter.** Every read path in
 * `attendee.repository.ts` filters on this column, so an archived attendee
 * cannot check in, cannot open their pass, cannot be served at a redemption
 * counter and is not in the raffle pool. A column that only hid a row from one
 * administrator's table while the person still walked through the door would be
 * close to a lie.
 *
 * A timestamp rather than a boolean, for the reason `002_attendees-table.ts`
 * gives for the `*_redeemed_at` columns: they "carry a redemption time rather
 * than a boolean flag". When a row was retired is worth more than that it was,
 * and it costs the same.
 *
 * **The `SELECT` grant is the load-bearing half.** Those read paths filter on
 * the column and never project it, and `005_app-role-grants.ts` is explicit
 * that Postgres "checks column privileges on anything a statement references,
 * `WHERE` clauses included". Without it the first real check-in after this
 * migration fails, and nothing earlier does.
 *
 * Deliberately absent:
 *
 * - **`archived_by`.** Who archived a row goes to the request log, which is
 *   where every other administrator action already goes. One column is not an
 *   audit trail, and a table that pretends to be one is worse than the honest
 *   gap.
 * - **An index.** A few hundred rows per event; a partial index on
 *   `(event_id) WHERE archived_at IS NULL` would be an optimisation with no
 *   measurement behind it.
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
    archived_at: { type: 'timestamptz' },
  });

  pgm.sql(`GRANT SELECT (archived_at) ON attendees TO ${role}`);
  pgm.sql(`GRANT UPDATE (archived_at) ON attendees TO ${role}`);
};

/**
 * Drops the column.
 *
 * Column privileges are dropped with the column, so there is nothing to revoke
 * first — the note `007_attendee-nickname.ts` carries.
 *
 * Rolling back loses which rows were archived. That is not recoverable, and it
 * is the same trade every `dropColumn` makes.
 */
export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumn('attendees', 'archived_at');
};
