import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Narrows the application role's access to `attendees` to the columns it
 * actually uses.
 *
 * The role is created by `scripts/db/init/01-roles.sh`, which runs before any
 * migration and so cannot grant on a table that does not exist yet. The column
 * list is a property of the schema and moves with it.
 *
 * **Extending a projection in `attendee.repository.ts` requires a matching
 * grant migration.** Postgres checks column privileges on anything a statement
 * references, `WHERE` clauses included — which is why `event_id` and
 * `ticket_link_token` appear here despite never reaching the caller.
 *
 * `created_at` and `updated_at` are omitted deliberately, so a stray `SELECT *`
 * fails loudly rather than quietly widening what the application can see.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Reads the application role name from the environment.
 *
 * `POSTGRES_USER` is what the application connects as, so taking the name from
 * there keeps one source of truth with `01-roles.sh` and the running container.
 * The value is interpolated into SQL as an identifier, so it is constrained to
 * an unquoted-identifier shape rather than trusted.
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

/** Columns the application reads, whether projected or only filtered on. */
const READABLE_COLUMNS = [
  'attendee_id',
  'event_id',
  'ticket_code',
  'ticket_link_token',
  'attendee_phone',
  'attendee_name',
  'attendee_role',
  'checkin_complete',
  'checkin_at',
  'checkin_number',
  'meal_option',
  'meal_redeemed_at',
  'drink_option',
  'drink_redeemed_at',
  'tshirt_size',
  'tshirt_redeemed_at',
].join(', ');

/** Columns `completeCheckin` writes. */
const WRITABLE_COLUMNS = [
  'checkin_complete',
  'checkin_at',
  'checkin_number',
  'updated_at',
].join(', ');

export const up = (pgm: MigrationBuilder): void => {
  const role = appRole();

  // Revoke first so the resulting privileges are exactly what is listed here,
  // regardless of anything granted by hand beforehand.
  pgm.sql(`REVOKE ALL ON attendees FROM ${role}`);

  pgm.sql(`GRANT SELECT (${READABLE_COLUMNS}) ON attendees TO ${role}`);
  pgm.sql(`GRANT UPDATE (${WRITABLE_COLUMNS}) ON attendees TO ${role}`);

  // completeCheckin calls nextval() to assign the check-in number.
  pgm.sql(`GRANT USAGE ON SEQUENCE checkin_number_seq TO ${role}`);
};

export const down = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.sql(`REVOKE ALL ON attendees FROM ${role}`);
  pgm.sql(`REVOKE ALL ON SEQUENCE checkin_number_seq FROM ${role}`);
};
