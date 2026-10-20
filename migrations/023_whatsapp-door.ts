import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Creates the storage for the door message: the WhatsApp template sent from
 * `/admin/attendees` to an attendee created there or whose number was just
 * corrected there, and the switch that allows it.
 *
 * - `whatsapp_door_state` is the switch, one row per event, in Postgres for the
 *   reason `020` gives for `survey_state`: an operator's decision to stop has to
 *   survive a container recreate and must not need a shell on the host. **A
 *   missing row is off**, so the feature is dark until somebody turns it on.
 * - `whatsapp_door_sends` is one row per door message. It is its own table
 *   rather than rows in `whatsapp_sends` because every one of those belongs to a
 *   run, and a run is what `/admin/mensagens` shows and drives; a door message
 *   is neither.
 *
 * **`whatsapp_door_sends` holds personal data** — `to_e164`, `attendee_id`, and
 * `wamid`, which Meta can join back to a number — and is inventoried in
 * `docs/security/data-retention.md`. `to_e164` is redacted by both purge scripts and
 * `wamid` by `purge-attendees.sql`.
 *
 * `to_e164` is stored rather than read off the attendee because the attendee's
 * number is exactly what changes: the rule is one door message per **number**,
 * so a corrected number can be sent to while the wrong one it replaced cannot
 * be sent to again.
 *
 * Every table carries `event_id` with no default, following `006`. **No foreign
 * keys**, following `009`, `012` and `018`. No `DELETE` on either table: a door
 * row is both the no-double-send guard and part of the spend the budget is
 * measured against, so removing one would re-open a number to a second message
 * and hand the budget back money that was spent.
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
 * Columns the switch's upsert supplies when it creates the event's row.
 * `updated_at` takes its default.
 */
const STATE_INSERTABLE_COLUMNS = ['event_id', 'enabled', 'updated_by'].join(
  ', ',
);

/**
 * Columns the switch's upsert moves on an existing row. `updated_at` is here
 * because a default applies only on insert, so the upsert sets it explicitly.
 */
const STATE_UPDATABLE_COLUMNS = ['enabled', 'updated_by', 'updated_at'].join(
  ', ',
);

/** Columns the budget reservation supplies. A row is always born `sending`. */
const SEND_INSERTABLE_COLUMNS = [
  'event_id',
  'attendee_id',
  'template_key',
  'to_e164',
  'status',
  'created_by',
].join(', ');

/** Columns settling a send moves once Meta has answered. */
const SEND_UPDATABLE_COLUMNS = [
  'status',
  'wamid',
  'error_code',
  'error_title',
  'sent_at',
].join(', ');

export const up = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.createTable('whatsapp_door_state', {
    event_id: { type: 'text', primaryKey: true },

    enabled: { type: 'boolean', notNull: true },

    /** `admins.admin_id` of whoever last flipped the switch. */
    updated_by: { type: 'uuid' },

    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createTable('whatsapp_door_sends', {
    send_id: { type: 'bigserial', primaryKey: true },

    event_id: { type: 'text', notNull: true },

    attendee_id: { type: 'uuid', notNull: true },

    /** Registry key, so the spend can be priced by the template's category. */
    template_key: { type: 'text', notNull: true },

    /** The number sent to. Null once a purge script has redacted it. */
    to_e164: { type: 'text' },

    /**
     * `sending` is written, and committed, before the HTTP call. It is the
     * budget reservation: spend counts it, so a crash mid-call leaves money
     * accounted for rather than silently released.
     */
    status: {
      type: 'text',
      notNull: true,
      check: "status IN ('sending', 'sent', 'failed')",
    },

    /** Meta's message id. */
    wamid: { type: 'text' },

    error_code: { type: 'integer' },

    /** Meta's error title, or the transport failure's name. */
    error_title: { type: 'text' },

    /** `admins.admin_id` of whoever saved the attendee: the audit trail. */
    created_by: { type: 'uuid' },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },

    sent_at: { type: 'timestamptz' },
  });

  // One door message per number. The service checks this under its budget lock;
  // this is the backstop. Partial on the states that count, so a failed send
  // frees the number for a retry, and on a present number, so rows the purge
  // scripts redacted stop colliding.
  pgm.createIndex('whatsapp_door_sends', ['event_id', 'to_e164'], {
    name: 'whatsapp_door_sends_number_once',
    unique: true,
    where: "status IN ('sending', 'sent') AND to_e164 IS NOT NULL",
  });

  // The per-attendee cap's count.
  pgm.createIndex('whatsapp_door_sends', ['event_id', 'attendee_id'], {
    name: 'whatsapp_door_sends_attendee_index',
  });

  pgm.sql(
    `GRANT INSERT (${STATE_INSERTABLE_COLUMNS}) ON whatsapp_door_state TO ${role}`,
  );
  pgm.sql(
    `GRANT UPDATE (${STATE_UPDATABLE_COLUMNS}) ON whatsapp_door_state TO ${role}`,
  );

  pgm.sql(
    `GRANT INSERT (${SEND_INSERTABLE_COLUMNS}) ON whatsapp_door_sends TO ${role}`,
  );
  pgm.sql(
    `GRANT UPDATE (${SEND_UPDATABLE_COLUMNS}) ON whatsapp_door_sends TO ${role}`,
  );

  // Table-wide rather than column-listed: the application wrote every column
  // here, so there is nothing on these tables to withhold from it on read.
  pgm.sql(`GRANT SELECT ON whatsapp_door_state TO ${role}`);
  pgm.sql(`GRANT SELECT ON whatsapp_door_sends TO ${role}`);

  // `INSERT` alone does not permit a `bigserial` default. See `018`.
  pgm.sql(`GRANT USAGE ON SEQUENCE whatsapp_door_sends_send_id_seq TO ${role}`);
};

/** Drops what `up` created, revoking column by column in reverse. */
export const down = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.sql(
    `REVOKE USAGE ON SEQUENCE whatsapp_door_sends_send_id_seq FROM ${role}`,
  );

  pgm.sql(`REVOKE SELECT ON whatsapp_door_sends FROM ${role}`);
  pgm.sql(`REVOKE SELECT ON whatsapp_door_state FROM ${role}`);

  pgm.sql(
    `REVOKE UPDATE (${SEND_UPDATABLE_COLUMNS}) ON whatsapp_door_sends FROM ${role}`,
  );
  pgm.sql(
    `REVOKE INSERT (${SEND_INSERTABLE_COLUMNS}) ON whatsapp_door_sends FROM ${role}`,
  );

  pgm.sql(
    `REVOKE UPDATE (${STATE_UPDATABLE_COLUMNS}) ON whatsapp_door_state FROM ${role}`,
  );
  pgm.sql(
    `REVOKE INSERT (${STATE_INSERTABLE_COLUMNS}) ON whatsapp_door_state FROM ${role}`,
  );

  pgm.dropTable('whatsapp_door_sends');
  pgm.dropTable('whatsapp_door_state');
};
