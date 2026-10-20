import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Creates the storage for the ticket limit: the cap on how many participant
 * tickets the attendees editor can issue, and what happens when it is reached.
 *
 * - `ticket_limit_state` is one row per event, in Postgres for the reason `020`
 *   gives for `survey_state` and `023` for `whatsapp_door_state`: an operator's
 *   decision has to survive a container recreate, apply on the next request
 *   without a restart, and must not need a shell on the host. **A missing row
 *   is off**, so the limit is dark until somebody sets it.
 * - `scope` says what counts towards the cap: `total` is every participant
 *   ticket, `door` only the codes the editor generated. `off` is the switch.
 *   The service decides what each means; the column only bounds the values.
 * - `mode` says what reaching the cap does: `hard` refuses the create, `warn`
 *   lets it through and says so.
 * - `cap` is required unless the scope is `off`, and an `off` row keeps its last
 *   cap and mode so the form can offer them again. The bounds are the rules
 *   module's (`admin.ticket-limit.rules.ts`), repeated here as the backstop for
 *   a write that bypasses the service.
 *
 * Holds no personal data.
 *
 * Carries `event_id` with no default, following `006`. **No foreign keys**,
 * following `009`, `012` and `018`. No `DELETE`: turning the limit off sets
 * `scope = 'off'`, so a row is never removed and the last cap and mode survive.
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
 * Columns the limit's upsert supplies when it creates the event's row.
 * `updated_at` takes its default.
 */
const STATE_INSERTABLE_COLUMNS = [
  'event_id',
  'scope',
  'cap',
  'mode',
  'updated_by',
].join(', ');

/**
 * Columns the limit's upsert moves on an existing row. `updated_at` is here
 * because a default applies only on insert, so the upsert sets it explicitly.
 */
const STATE_UPDATABLE_COLUMNS = [
  'scope',
  'cap',
  'mode',
  'updated_by',
  'updated_at',
].join(', ');

export const up = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.createTable('ticket_limit_state', {
    event_id: { type: 'text', primaryKey: true },

    scope: {
      type: 'text',
      notNull: true,
      check: "scope IN ('off', 'total', 'door')",
    },

    /** Null only while the limit has never been set above `off`. */
    cap: { type: 'integer' },

    mode: {
      type: 'text',
      notNull: true,
      check: "mode IN ('hard', 'warn')",
    },

    /** `admins.admin_id` of whoever last changed the limit. */
    updated_by: { type: 'uuid' },

    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Table-level so it can read `scope`: an `off` row may hold no cap or a stale
  // one, any other scope must hold a cap inside the bounds.
  pgm.addConstraint('ticket_limit_state', 'ticket_limit_state_cap_check', {
    check: "scope = 'off' OR cap BETWEEN 1 AND 100000",
  });

  pgm.sql(
    `GRANT INSERT (${STATE_INSERTABLE_COLUMNS}) ON ticket_limit_state TO ${role}`,
  );
  pgm.sql(
    `GRANT UPDATE (${STATE_UPDATABLE_COLUMNS}) ON ticket_limit_state TO ${role}`,
  );

  // Table-wide rather than column-listed: the application writes every column
  // here, so there is nothing on this table to withhold from it on read.
  pgm.sql(`GRANT SELECT ON ticket_limit_state TO ${role}`);
};

/** Drops what `up` created, revoking column by column in reverse. */
export const down = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.sql(`REVOKE SELECT ON ticket_limit_state FROM ${role}`);

  pgm.sql(
    `REVOKE UPDATE (${STATE_UPDATABLE_COLUMNS}) ON ticket_limit_state FROM ${role}`,
  );
  pgm.sql(
    `REVOKE INSERT (${STATE_INSERTABLE_COLUMNS}) ON ticket_limit_state FROM ${role}`,
  );

  pgm.dropTable('ticket_limit_state');
};
