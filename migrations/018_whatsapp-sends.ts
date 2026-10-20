import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Creates the record of WhatsApp template sends: one row per run, and one row
 * per recipient of that run.
 *
 * Two tables rather than one because they answer different questions. A run is
 * what an operator started, against which template and audience, and why it
 * stopped. A send is what happened to one attendee — and it is the only table
 * the delivery-receipt webhook writes to.
 *
 * **`whatsapp_sends` holds personal data** — `to_e164`, `wa_id`, and
 * `attendee_id` — and both tables are inventoried in `docs/security/data-retention.md`.
 * That is why each carries `event_id`: every statement in
 * `scripts/db/purge-attendees.sql` scopes on it. It carries no default,
 * following `006`: a missing event is a not-null violation rather than a row
 * filed under the wrong evening.
 *
 * **No foreign keys**, following `009` and `012`. `run_id`, `attendee_id` and
 * `started_by` are bare uuids: the purge redacts rows rather than deleting them,
 * so there is no cascade to reason about.
 *
 * **`attendees` needs no grant change.** `005` already grants `SELECT` on
 * `attendee_phone` and `ticket_link_token`, and `015` on `archived_at`, so every
 * column the enqueue query reads or filters on is readable already.
 *
 * **`whatsapp_runs.run_id` is a uuid default, not a sequence**, and needs no
 * grant. Only `whatsapp_sends_send_id_seq` does.
 *
 * No `DELETE` on either table. These rows are the record of what was sent to
 * whom; the purge scripts, run as the migrator, are what redact them.
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

/** Columns the application supplies when an operator confirms a run. */
const RUN_INSERTABLE_COLUMNS = [
  'event_id',
  'template_key',
  'target_role',
  'status',
  'started_by',
  'total_recipients',
].join(', ');

/** Columns a run's lifecycle moves after it is created. */
const RUN_UPDATABLE_COLUMNS = [
  'status',
  'stop_reason',
  'started_at',
  'finished_at',
].join(', ');

/**
 * Columns the enqueue supplies.
 *
 * `to_e164` and `error_title` are here because a recipient whose phone cannot
 * be normalised is born `skipped`, with the reason, rather than omitted.
 */
const SEND_INSERTABLE_COLUMNS = [
  'run_id',
  'event_id',
  'attendee_id',
  'template_key',
  'status',
  'to_e164',
  'error_title',
].join(', ');

/**
 * Columns the runner and the receipt webhook move.
 *
 * The last five are the receipt columns, and they appear in this list and in
 * no insert list: a row is never born with a delivery state.
 */
const SEND_UPDATABLE_COLUMNS = [
  'status',
  'to_e164',
  'wa_id',
  'wamid',
  'message_status',
  'error_code',
  'error_title',
  'error_detail',
  'attempts',
  'claimed_at',
  'sent_at',
  'delivery_status',
  'delivered_at',
  'read_at',
  'delivery_error_code',
  'delivery_error_title',
].join(', ');

export const up = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.createTable('whatsapp_runs', {
    run_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },

    event_id: { type: 'text', notNull: true },

    /** `name:language`, a key into `src/constants/whatsapp-templates.ts`. */
    template_key: { type: 'text', notNull: true },

    target_role: {
      type: 'text',
      notNull: true,
      check: "target_role IN ('participant', 'volunteer')",
    },

    status: {
      type: 'text',
      notNull: true,
      check: "status IN ('running', 'paused', 'done', 'failed')",
    },

    /** `admins.admin_id` of whoever confirmed the run. */
    started_by: { type: 'uuid', notNull: true },

    /** Snapshot at confirm time, so progress reads against what was seen. */
    total_recipients: { type: 'integer', notNull: true },

    /** `OPERATOR`, `FATAL_<code>` or `CIRCUIT_BREAKER`. */
    stop_reason: { type: 'text' },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },

    started_at: { type: 'timestamptz' },

    finished_at: { type: 'timestamptz' },
  });

  pgm.createTable('whatsapp_sends', {
    send_id: { type: 'bigserial', primaryKey: true },

    run_id: { type: 'uuid', notNull: true },

    event_id: { type: 'text', notNull: true },

    attendee_id: { type: 'uuid', notNull: true },

    /**
     * Denormalised from `whatsapp_runs` so that `whatsapp_sends_delivered_once`
     * can exist: a join cannot be a unique index.
     */
    template_key: { type: 'text', notNull: true },

    /** The number actually sent to. Null when the row was skipped. */
    to_e164: { type: 'text' },

    /** The number Meta canonicalised to, which in Brazil can differ. */
    wa_id: { type: 'text' },

    /**
     * `sending` is written before the HTTP call, so a crash mid-call leaves
     * evidence. `interrupted` is what such a row becomes on restart.
     */
    status: {
      type: 'text',
      notNull: true,
      check:
        "status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'deferred', 'interrupted')",
    },

    /** Meta's message id; the receipt webhook's join key. */
    wamid: { type: 'text' },

    /** `accepted`, `held_for_quality_assessment` or `paused`. */
    message_status: { type: 'text' },

    error_code: { type: 'integer' },

    /** A classification we assign, so failures group; not Meta's text. */
    error_title: { type: 'text' },

    /** Meta's `error_data.details`, truncated by the caller. */
    error_detail: { type: 'text' },

    attempts: { type: 'integer', notNull: true, default: 0 },

    claimed_at: { type: 'timestamptz' },

    sent_at: { type: 'timestamptz' },

    /**
     * What Meta reported back, deliberately separate from `status`, which is
     * what this application did.
     *
     * The separation is a correctness requirement. `whatsapp_sends_delivered_once`
     * is partial on `status = 'sent'`, so a receipt that advanced `status` to
     * `delivered` would lift the row out of that index and re-open the attendee
     * to a second send. Receipt writes only ever advance this column by rank.
     */
    delivery_status: {
      type: 'text',
      check: "delivery_status IN ('sent', 'delivered', 'read', 'undelivered')",
    },

    /** First `delivered` receipt. Never overwritten. */
    delivered_at: { type: 'timestamptz' },

    /** First `read` receipt. Never overwritten. */
    read_at: { type: 'timestamptz' },

    /** From a `failed` status event. */
    delivery_error_code: { type: 'integer' },

    delivery_error_title: { type: 'text' },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // The runner's claim query: the next pending row of a run.
  pgm.createIndex('whatsapp_sends', ['run_id', 'status', 'send_id'], {
    name: 'whatsapp_sends_claim_index',
  });

  // The receipt webhook's only lookup. Partial, because a skipped or failed
  // row never carries a wamid.
  pgm.createIndex('whatsapp_sends', 'wamid', {
    name: 'whatsapp_sends_wamid_key',
    unique: true,
    where: 'wamid IS NOT NULL',
  });

  // One row per attendee per run. What makes the enqueue's
  // `INSERT … ON CONFLICT DO NOTHING` a no-op on a repeated confirm.
  pgm.addConstraint('whatsapp_sends', 'whatsapp_sends_run_attendee_key', {
    unique: ['run_id', 'attendee_id'],
  });

  // The no-double-send constraint. Partial on the succeeded state, so a failed
  // attempt can be re-queued by a later run but a sent one never can. A bug
  // that selects an already-messaged attendee fails here with a unique
  // violation rather than reaching somebody's phone.
  pgm.createIndex(
    'whatsapp_sends',
    ['event_id', 'attendee_id', 'template_key'],
    {
      name: 'whatsapp_sends_delivered_once',
      unique: true,
      where: "status = 'sent'",
    },
  );

  // One live run per event, enforced here rather than in the service, so two
  // operators pressing start at once is a caught unique violation, not a race.
  pgm.createIndex('whatsapp_runs', 'event_id', {
    name: 'whatsapp_runs_one_active',
    unique: true,
    where: "status IN ('running', 'paused')",
  });

  pgm.sql(
    `GRANT INSERT (${RUN_INSERTABLE_COLUMNS}) ON whatsapp_runs TO ${role}`,
  );
  pgm.sql(
    `GRANT UPDATE (${RUN_UPDATABLE_COLUMNS}) ON whatsapp_runs TO ${role}`,
  );

  pgm.sql(
    `GRANT INSERT (${SEND_INSERTABLE_COLUMNS}) ON whatsapp_sends TO ${role}`,
  );
  pgm.sql(
    `GRANT UPDATE (${SEND_UPDATABLE_COLUMNS}) ON whatsapp_sends TO ${role}`,
  );

  // Table-wide rather than column-listed: the application wrote every column
  // here, so there is nothing on these tables to withhold from it on read.
  pgm.sql(`GRANT SELECT ON whatsapp_runs TO ${role}`);
  pgm.sql(`GRANT SELECT ON whatsapp_sends TO ${role}`);

  // `INSERT` alone does not permit a `bigserial` default — the first send
  // would fail at runtime with `permission denied for sequence`, long after
  // the migration reported success. `017` grants `app_events_id_seq` the same
  // way.
  pgm.sql(`GRANT USAGE ON SEQUENCE whatsapp_sends_send_id_seq TO ${role}`);
};

/**
 * Drops what `up` created, revoking column by column in reverse.
 *
 * `whatsapp_sends` goes before `whatsapp_runs`, the child before the table it
 * points at, so the order still holds if a foreign key is ever added. Dropping
 * each table takes its sequence and indexes with it.
 */
export const down = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.sql(`REVOKE USAGE ON SEQUENCE whatsapp_sends_send_id_seq FROM ${role}`);

  pgm.sql(`REVOKE SELECT ON whatsapp_sends FROM ${role}`);
  pgm.sql(`REVOKE SELECT ON whatsapp_runs FROM ${role}`);

  pgm.sql(
    `REVOKE UPDATE (${SEND_UPDATABLE_COLUMNS}) ON whatsapp_sends FROM ${role}`,
  );
  pgm.sql(
    `REVOKE INSERT (${SEND_INSERTABLE_COLUMNS}) ON whatsapp_sends FROM ${role}`,
  );

  pgm.sql(
    `REVOKE UPDATE (${RUN_UPDATABLE_COLUMNS}) ON whatsapp_runs FROM ${role}`,
  );
  pgm.sql(
    `REVOKE INSERT (${RUN_INSERTABLE_COLUMNS}) ON whatsapp_runs FROM ${role}`,
  );

  pgm.dropTable('whatsapp_sends');
  pgm.dropTable('whatsapp_runs');
};
