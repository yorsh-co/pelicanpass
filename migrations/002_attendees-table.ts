import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Creates the attendees table.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

export const up = (pgm: MigrationBuilder): void => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  pgm.createTable('attendees', {
    attendee_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    event_id: { type: 'text' },

    ticket_code: { type: 'varchar(5)', notNull: true, unique: true },
    attendee_name: { type: 'text', notNull: true },
    attendee_phone: { type: 'varchar(20)', notNull: true },

    attendee_role: {
      type: 'text',
      notNull: true,
      check: "attendee_role IN ('participant', 'volunteer')",
      default: 'participant',
    },

    checkin_complete: { type: 'boolean', notNull: true, default: false },
    checkin_at: { type: 'timestamptz' },
    checkin_number: { type: 'integer', unique: true },

    meal_option: { type: 'text' },
    meal_redeemed_at: { type: 'timestamptz' },

    drink_option: { type: 'text' },
    drink_redeemed_at: { type: 'timestamptz' },

    tshirt_size: { type: 'text' },
    tshirt_redeemed_at: { type: 'timestamptz' },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: { type: 'timestamptz' },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('attendees');
};
