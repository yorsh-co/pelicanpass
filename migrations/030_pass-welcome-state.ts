import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Creates `pass_welcome_state`, the administrator's welcome schedule: when the
 * line under the attendee's name switches text, saved from `/admin/pass`.
 *
 * One row per event, in Postgres for the reason `020` gives for `survey_state`:
 * a change made on the day has to survive a container recreate and must not
 * need a shell on the host. **A missing row, or a null `schedule`, leaves
 * `PASS_WELCOME_SCHEDULE` in charge**, so the `.env` value stays the default
 * and handing back to it is an update rather than a delete.
 *
 * `schedule` is the whole list as a JSON array of `{ phase, at }`, `at` an
 * ISO-8601 instant. A list rather than a row per entry because the rule that
 * makes a schedule valid — strictly ascending — is a property of the list, and
 * one row is replaced in one statement.
 *
 * `revision` counts saves, and is what a save names to say which version it
 * was made against: the update applies only while it still matches, so two
 * administrators editing at once cannot silently overwrite each other. An
 * integer rather than `updated_at`, which has microseconds a browser's
 * millisecond `Date` cannot carry back.
 *
 * Holds no attendee data: `updated_by` is an `admins.admin_id`. Follows `006`
 * on `event_id` and `009` on foreign keys. No `DELETE` grant.
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

/**
 * Columns the save supplies when it creates the event's row. `updated_at`
 * takes its default.
 */
const INSERTABLE_COLUMNS = [
  'event_id',
  'schedule',
  'revision',
  'updated_by',
].join(', ');

/**
 * Columns a save moves on an existing row. `updated_at` is here because a
 * default applies only on insert, so the upsert sets it explicitly.
 */
const UPDATABLE_COLUMNS = [
  'schedule',
  'revision',
  'updated_by',
  'updated_at',
].join(', ');

export const up = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.createTable('pass_welcome_state', {
    event_id: { type: 'text', primaryKey: true },

    /** Null hands the event back to `PASS_WELCOME_SCHEDULE`. */
    schedule: {
      type: 'jsonb',
      check: "schedule IS NULL OR jsonb_typeof(schedule) = 'array'",
    },

    /** 1 on the first save, one more on each after it. */
    revision: { type: 'integer', notNull: true, check: 'revision > 0' },

    /** `admins.admin_id` of whoever saved last. */
    updated_by: { type: 'uuid' },

    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.sql(
    `GRANT INSERT (${INSERTABLE_COLUMNS}) ON pass_welcome_state TO ${role}`,
  );
  pgm.sql(
    `GRANT UPDATE (${UPDATABLE_COLUMNS}) ON pass_welcome_state TO ${role}`,
  );

  // Table-wide rather than column-listed: the application wrote every column,
  // so there is nothing here to withhold from it on read.
  pgm.sql(`GRANT SELECT ON pass_welcome_state TO ${role}`);
};

/** Drops what `up` created, revoking in reverse. */
export const down = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.sql(`REVOKE SELECT ON pass_welcome_state FROM ${role}`);
  pgm.sql(
    `REVOKE UPDATE (${UPDATABLE_COLUMNS}) ON pass_welcome_state FROM ${role}`,
  );
  pgm.sql(
    `REVOKE INSERT (${INSERTABLE_COLUMNS}) ON pass_welcome_state FROM ${role}`,
  );

  pgm.dropTable('pass_welcome_state');
};
