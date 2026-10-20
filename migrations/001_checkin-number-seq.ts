import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Adds a global sequence used to assign sequential check-in numbers.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

export const up = (pgm: MigrationBuilder): void => {
  pgm.createSequence('checkin_number_seq', { start: 1 });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropSequence('checkin_number_seq');
};
