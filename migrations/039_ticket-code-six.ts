import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Tightens the ticket code format constraint to six characters.
 *
 * Every ticket code is exactly six lowercase alphanumerics: a one-character key
 * followed by five. `src/constants/ticket.ts` is the source of truth and the
 * service validates against it before any write. This constraint is the
 * backstop for a write that bypasses the service, such as a hand-typed `INSERT`
 * in `psql`, so a malformed code cannot enter the table and lock its holder out
 * of check-in. It replaces the constraint added by migration `038`, which
 * accepted the seven-character shapes.
 *
 * The pattern is written out literally rather than imported: a migration is a
 * snapshot that has to keep running unchanged, so it does not follow later
 * edits to that module.
 *
 * `up` fails while any row still holds a seven-character code, which is
 * intended: rewriting a ticket code silently would invalidate passes already
 * issued. Purge or reseed non-production databases first. `down` likewise fails
 * while any six-character row exists, because the restored pattern requires
 * seven.
 *
 * The `varchar(7)` column is left as is: the constraint fixes the length, so
 * narrowing the column would add a table rewrite and no protection.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

export const up = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('attendees', 'attendees_ticket_code_format');
  pgm.addConstraint('attendees', 'attendees_ticket_code_format', {
    check: "ticket_code ~ '^[a-z0-9]{6}$'",
  });
};

/** Restores the seven-character constraint from migration `038`. */
export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('attendees', 'attendees_ticket_code_format');
  pgm.addConstraint('attendees', 'attendees_ticket_code_format', {
    check: "ticket_code ~ '^([a-z]-|[a-z0-9]{2})[a-z0-9]{5}$'",
  });
};
