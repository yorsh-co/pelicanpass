import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Creates the durable telemetry table, and an aggregate view that lets the
 * dashboard count redemptions without being able to read them.
 *
 * Until now the only record of an error was a log line: on stdout for the
 * container's lifetime, and — since the rotating file stream landed — in
 * `warn`+ NDJSON on a volume. Neither is queryable, so "what broke, how often,
 * and is it still happening" could only be answered by reading. `app_events` is
 * the indexed second sink `recordEvent` already fans out to.
 *
 * **This table holds personal data** — `ip`, `actor_id`, and whatever survives
 * scrubbing into `context` — and is inventoried in `docs/security/data-retention.md`
 * alongside the log volume. That is why `event_id` is here: every statement in
 * `scripts/db/purge-attendees.sql` scopes on it, and a personal-data table
 * without one cannot be purged for a single event without destroying another's.
 * It carries no default, following `006`: a missing event is a not-null
 * violation rather than a row filed under the wrong evening.
 *
 * The grants below are wider than this schema usually gives the application
 * role, and deliberately so. Both are argued at their call sites.
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
 * Columns the telemetry sink supplies on an insert.
 *
 * `id` and `occurred_at` are omitted because both carry defaults and neither is
 * ever written by hand — the same reason `009` omits `redemption_id` and
 * `created_at`. Note that omitting `id` from this list does **not** remove the
 * need for the sequence grant below: the default expression still runs as the
 * inserting role.
 */
const INSERTABLE_COLUMNS = [
  'event_id',
  'severity',
  'kind',
  'code',
  'fingerprint',
  'message',
  'route',
  'status_code',
  'request_id',
  'actor_type',
  'actor_id',
  'ip',
  'release_id',
  'context',
].join(', ');

export const up = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.createTable('app_events', {
    id: { type: 'bigserial', primaryKey: true },

    occurred_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },

    event_id: { type: 'text', notNull: true },

    severity: {
      type: 'text',
      notNull: true,
      check: "severity IN ('info', 'warn', 'error', 'fatal')",
    },

    kind: {
      type: 'text',
      notNull: true,
      check: "kind IN ('http_error', 'client_error', 'security', 'domain')",
    },

    /** `AppErrorCode`, or `UNCAUGHT` for something that escaped a handler. */
    code: { type: 'text' },

    /**
     * Groups occurrences into a class of failure. Computed by `fingerprintOf`
     * in `src/shared/telemetry/record.ts`, which is also what keys alert
     * deduplication — so a row and the Discord message about it agree.
     */
    fingerprint: { type: 'text', notNull: true },

    message: { type: 'text', notNull: true },

    /** Already masked by `maskUrlSecrets` at the call site. */
    route: { type: 'text' },

    status_code: { type: 'integer' },

    request_id: { type: 'text' },

    /**
     * `anon` plus the `SessionType` union: `checkin`, `attendee`, `admin`.
     * Deliberately the session taxonomy rather than a role one — `volunteer` is
     * an `attendee_role` and would need a mapping that could drift.
     */
    actor_type: { type: 'text' },

    /** An id. Never a name, and never a ticket code. */
    actor_id: { type: 'text' },

    ip: { type: 'inet' },

    release_id: { type: 'text' },

    /** Scrubbed through `telemetry/scrub.ts` before it reaches this column. */
    context: { type: 'jsonb' },
  });

  // The dashboard's default read: most recent first, over a bounded window.
  pgm.createIndex('app_events', [{ name: 'occurred_at', sort: 'DESC' }]);

  // The "top errors" panel and any "is this one still firing" question.
  pgm.createIndex('app_events', [
    { name: 'fingerprint' },
    { name: 'occurred_at', sort: 'DESC' },
  ]);

  // Partial, because the failures are a small fraction of the rows and are the
  // only ones anybody pages through by hand.
  pgm.createIndex('app_events', [{ name: 'occurred_at', sort: 'DESC' }], {
    name: 'app_events_failures_occurred_at_index',
    where: "severity IN ('error', 'fatal')",
  });

  pgm.sql(`GRANT INSERT (${INSERTABLE_COLUMNS}) ON app_events TO ${role}`);

  // Table-wide rather than column-listed: the application wrote every column
  // here, so there is nothing on this table to withhold from it on read.
  pgm.sql(`GRANT SELECT ON app_events TO ${role}`);

  // `INSERT` alone does not permit a `bigserial` default — the first insert
  // would fail at runtime with `permission denied for sequence`, long after the
  // migration reported success. `005` grants `checkin_number_seq` the same way.
  pgm.sql(`GRANT USAGE ON SEQUENCE app_events_id_seq TO ${role}`);

  // Required by the retention sweep in `telemetry/events.ts`, which is the
  // application's own statement rather than an operator's.
  //
  // The cost, stated rather than buried: a flaw in the application could erase
  // the record of its own errors. Accepted, because the grant is on this table
  // alone — `redemptions` remains INSERT-only and un-SELECT-able, and that is
  // the audit trail that matters — and because the alternative is an
  // operational table growing without bound on a host nobody is watching.
  pgm.sql(`GRANT DELETE ON app_events TO ${role}`);

  // Counts over `redemptions` without a row read.
  //
  // `009` deliberately withholds SELECT on that table from the application
  // role: it is an append-only audit trail, and the dashboard must not weaken
  // it. This view is owned by the migrator — node-pg-migrate connects as
  // POSTGRES_MIGRATOR_USER, so ownership follows from who runs the migration
  // and needs no ALTER — and `security_invoker = false` makes it execute with
  // the owner's rights.
  //
  // That is the Postgres 16 default. It is written out anyway because the whole
  // mechanism turns on it: a property the migration states cannot be quietly
  // reversed by a future default, and a reader should not have to know the
  // version to know this is safe.
  //
  // `event_id` is projected and grouped. Without it the dashboard would
  // aggregate across every event the database has ever held — a wrong answer
  // that looks like a right one, on a repository reused across events.
  pgm.sql(`
    CREATE VIEW redemption_metrics WITH (security_invoker = false) AS
      SELECT event_id,
             date_trunc('minute', created_at) AS bucket,
             item,
             outcome,
             count(*) AS n
      FROM redemptions
      GROUP BY 1, 2, 3, 4
  `);

  pgm.sql(`GRANT SELECT ON redemption_metrics TO ${role}`);
};

/**
 * Drops what `up` created, revoking column by column.
 *
 * The view goes before the table it does not depend on, and before the revokes,
 * so a partial failure leaves nothing granted on an object that is gone.
 * Dropping `app_events` takes its own sequence and indexes with it.
 */
export const down = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.sql(`REVOKE SELECT ON redemption_metrics FROM ${role}`);
  pgm.sql('DROP VIEW redemption_metrics');

  pgm.sql(`REVOKE DELETE ON app_events FROM ${role}`);
  pgm.sql(`REVOKE USAGE ON SEQUENCE app_events_id_seq FROM ${role}`);
  pgm.sql(`REVOKE SELECT ON app_events FROM ${role}`);
  pgm.sql(`REVOKE INSERT (${INSERTABLE_COLUMNS}) ON app_events FROM ${role}`);

  pgm.dropTable('app_events');
};
