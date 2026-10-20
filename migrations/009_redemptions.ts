import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Creates the redemption audit trail, and grants the writes that make a
 * redemption recordable.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Columns the application supplies on an audit insert.
 *
 * `redemption_id` and `created_at` are omitted because both carry defaults and
 * neither is ever written by hand.
 */
const INSERTABLE_COLUMNS = [
  'event_id',
  'attendee_id',
  'item',
  'outcome',
  'redeemed_by',
].join(', ');

/** The redemption timestamps a successful redeem stamps on `attendees`. */
const REDEEMED_AT_COLUMNS = [
  'meal_redeemed_at',
  'drink_redeemed_at',
  'tshirt_redeemed_at',
].join(', ');

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

  pgm.createTable('redemptions', {
    redemption_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    event_id: { type: 'text', notNull: true },

    attendee_id: { type: 'uuid', notNull: true },

    item: {
      type: 'text',
      notNull: true,
      check: "item IN ('meal', 'drink', 'tshirt')",
    },

    outcome: {
      type: 'text',
      notNull: true,
      check: "outcome IN ('redeemed', 'duplicate', 'not_entitled')",
    },

    redeemed_by: { type: 'uuid', notNull: true },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('redemptions', ['event_id', 'attendee_id']);

  pgm.sql(`GRANT INSERT (${INSERTABLE_COLUMNS}) ON redemptions TO ${role}`);

  pgm.sql(`GRANT UPDATE (${REDEEMED_AT_COLUMNS}) ON attendees TO ${role}`);
};

export const down = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.sql(`REVOKE UPDATE (${REDEEMED_AT_COLUMNS}) ON attendees FROM ${role}`);

  pgm.dropTable('redemptions');
};
