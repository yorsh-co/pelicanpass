import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Creates the experience questionnaire's storage: the answers, the record of
 * who answered, the release override, and the one view answers are read
 * through.
 *
 * The answers and the fact of answering are two tables with nothing that joins
 * them, because "anonymous" and "one response per attendee" pull against each
 * other: refusing a second submission means knowing who submitted.
 *
 * - `survey_responses` holds answers and the audience they were given under,
 *   and no person. It is the only table here whose rows survive teardown, in
 *   the anonymous per-audience CSVs.
 * - `survey_completions` **holds personal data** — `attendee_id` — and is the
 *   duplicate guard. It is inventoried in `docs/security/data-retention.md` and deleted
 *   by `scripts/db/purge-attendees.sql`.
 * - `survey_state` is the release override, one row per event, in Postgres so
 *   an operator's decision survives a container recreate.
 *
 * Every table carries `event_id` with no default, following `006`: a missing
 * event is a not-null violation rather than a row filed under the wrong
 * evening. **No foreign keys**, following `009`, `012` and `018`.
 *
 * **No sequences, and so no sequence grants.** `response_id` is a uuid default
 * and the other two tables have natural keys.
 *
 * The reasoning behind every omitted column and withheld grant is in
 * `docs/features/survey.md` § Anonymity, and is summarised at each call
 * site below.
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
 * Reads the read-only role name from the environment.
 *
 * The first migration to name this role. It is otherwise provisioned entirely
 * by `scripts/db/init/01-roles.sh`, whose format check this repeats. Local to
 * this file for the same reason as {@link appRole}.
 *
 * @returns The validated role name.
 * @throws {Error} If the variable is unset or is not a bare identifier.
 */
const readonlyRole = (): string => {
  const role = process.env.POSTGRES_READONLY_USER;

  if (!role) {
    throw new Error(
      'POSTGRES_READONLY_USER must be set: this migration revokes from it',
    );
  }

  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(
      `POSTGRES_READONLY_USER is not a bare SQL identifier: ${role}`,
    );
  }

  return role;
};

/**
 * Columns the submit supplies for an answer.
 *
 * `response_id` and `submitted_on` are omitted because both carry defaults and
 * neither is ever written by hand.
 */
const RESPONSE_INSERTABLE_COLUMNS = [
  'event_id',
  'audience',
  'survey_version',
  'answers',
].join(', ');

/** Every column of `survey_completions`, for both its insert and its read. */
const COMPLETION_COLUMNS = ['event_id', 'attendee_id'].join(', ');

/**
 * Columns the override's upsert supplies when it creates the event's row.
 * `updated_at` takes its default.
 */
const STATE_INSERTABLE_COLUMNS = ['event_id', 'override', 'updated_by'].join(
  ', ',
);

/**
 * Columns the override's upsert moves on an existing row. `updated_at` is here
 * because a default applies only on insert, so the upsert sets it explicitly.
 */
const STATE_UPDATABLE_COLUMNS = ['override', 'updated_by', 'updated_at'].join(
  ', ',
);

export const up = (pgm: MigrationBuilder): void => {
  const role = appRole();
  const readonly = readonlyRole();

  pgm.createTable('survey_responses', {
    /**
     * Random rather than a `bigserial`. A serial is submission order, and
     * submission order joins to anything else recorded in submission order.
     * Exports order by this column for the same reason.
     */
    response_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },

    event_id: { type: 'text', notNull: true },

    /**
     * Which question set the answers belong to. Identifies no one: roles are
     * not secret.
     */
    audience: {
      type: 'text',
      notNull: true,
      check: "audience IN ('participant', 'volunteer')",
    },

    /** The definition's derived `version` when the answers were accepted. */
    survey_version: { type: 'text', notNull: true },

    /** Question id to answer, validated against that version on submit. */
    answers: { type: 'jsonb', notNull: true },

    /**
     * A date, not a `timestamptz`. A precise time joins to the request log, to
     * `app_events`, and to the respondent's own check-in time.
     */
    submitted_on: {
      type: 'date',
      notNull: true,
      default: pgm.func('current_date'),
    },
  });

  pgm.createTable('survey_completions', {
    // The composite primary key is the one-response guard the submit's
    // `ON CONFLICT DO NOTHING` relies on. No timestamp, for the reason
    // `submitted_on` above is a date.
    event_id: { type: 'text', primaryKey: true },
    attendee_id: { type: 'uuid', primaryKey: true },
  });

  pgm.createTable('survey_state', {
    event_id: { type: 'text', primaryKey: true },

    /** `open` or `closed` forces the survey; null leaves it to the schedule. */
    override: {
      type: 'text',
      check: "override IN ('open', 'closed')",
    },

    /**
     * `admins.admin_id` of whoever last set the override. Null when
     * `purge-attendees.sql` closed it, since that runs as the migrator.
     */
    updated_by: { type: 'uuid' },

    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // No SELECT, on any column. An insert without `RETURNING` needs none, and
  // withholding it is what makes `survey_export` below the only way the
  // application can read an answer.
  pgm.sql(
    `GRANT INSERT (${RESPONSE_INSERTABLE_COLUMNS}) ON survey_responses TO ${role}`,
  );

  // SELECT because the submit's `ON CONFLICT DO NOTHING RETURNING` reads the
  // row it wrote, and the pass reports whether the attendee has answered. Both
  // columns are the whole table, but they are listed so that a column added
  // later is not readable by default.
  pgm.sql(
    `GRANT INSERT (${COMPLETION_COLUMNS}) ON survey_completions TO ${role}`,
  );
  pgm.sql(
    `GRANT SELECT (${COMPLETION_COLUMNS}) ON survey_completions TO ${role}`,
  );

  pgm.sql(
    `GRANT INSERT (${STATE_INSERTABLE_COLUMNS}) ON survey_state TO ${role}`,
  );
  pgm.sql(
    `GRANT UPDATE (${STATE_UPDATABLE_COLUMNS}) ON survey_state TO ${role}`,
  );

  // Table-wide rather than column-listed: the application wrote every column
  // here, so there is nothing on this table to withhold from it on read.
  pgm.sql(`GRANT SELECT ON survey_state TO ${role}`);

  // `01-roles.sh` grants the read-only role SELECT on every table the migrator
  // creates. Here that would undo the split between these two tables.
  //
  // Every row carries system columns, and two of them join the tables
  // outright. A completion and its response are written in one transaction, so
  // they share an `xmin`. Neither table is ever updated, so `ctid` order on each
  // is submission order, and ranking one against the other pairs them. Both are
  // readable by any role with table-level SELECT. Writing the two rows in
  // separate transactions would not help: adjacent transaction ids correlate as
  // well as equal ones.
  //
  // So the read-only role reads answers through `survey_export`, as the
  // application does, which leaves one way to read a response rather than a
  // column grant to keep in step with the view. It cannot read
  // `survey_completions` at all. The migrator and superusers still can;
  // `docs/features/survey.md` § Anonymity states that limit.
  pgm.sql(`REVOKE SELECT ON survey_responses FROM ${readonly}`);
  pgm.sql(`REVOKE SELECT ON survey_completions FROM ${readonly}`);

  // The only reader of `survey_responses`, for the admin download and the
  // teardown export alike.
  //
  // Owned by the migrator — node-pg-migrate connects as POSTGRES_MIGRATOR_USER,
  // so ownership follows from who runs the migration and needs no ALTER — and
  // `security_invoker = false` makes it execute with the owner's rights, so the
  // application reads through it without SELECT on the table beneath.
  //
  // That is the Postgres 16 default. It is written out anyway because the whole
  // mechanism turns on it: a property the migration states cannot be quietly
  // reversed by a future default, and a reader should not have to know the
  // version to know this is safe.
  //
  // It projects named columns, so no system column is reachable through it,
  // and a column added to the table later is not exported until this view says
  // so.
  pgm.sql(`
    CREATE VIEW survey_export WITH (security_invoker = false) AS
      SELECT event_id,
             audience,
             response_id,
             submitted_on,
             survey_version,
             answers
      FROM survey_responses
  `);

  // The read-only role needs no grant here: the default privileges in
  // `01-roles.sh` cover views as well as tables.
  pgm.sql(`GRANT SELECT ON survey_export TO ${role}`);
};

/**
 * Drops what `up` created, revoking column by column in reverse.
 *
 * The view goes first, since it depends on `survey_responses`. The read-only
 * role's SELECT is not restored: it was revoked from tables this drops.
 */
export const down = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.sql(`REVOKE SELECT ON survey_export FROM ${role}`);
  pgm.sql('DROP VIEW survey_export');

  pgm.sql(`REVOKE SELECT ON survey_state FROM ${role}`);
  pgm.sql(
    `REVOKE UPDATE (${STATE_UPDATABLE_COLUMNS}) ON survey_state FROM ${role}`,
  );
  pgm.sql(
    `REVOKE INSERT (${STATE_INSERTABLE_COLUMNS}) ON survey_state FROM ${role}`,
  );

  pgm.sql(
    `REVOKE SELECT (${COMPLETION_COLUMNS}) ON survey_completions FROM ${role}`,
  );
  pgm.sql(
    `REVOKE INSERT (${COMPLETION_COLUMNS}) ON survey_completions FROM ${role}`,
  );

  pgm.sql(
    `REVOKE INSERT (${RESPONSE_INSERTABLE_COLUMNS}) ON survey_responses FROM ${role}`,
  );

  pgm.dropTable('survey_state');
  pgm.dropTable('survey_completions');
  pgm.dropTable('survey_responses');
};
