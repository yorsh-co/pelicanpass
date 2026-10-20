import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Enforces the ticket code format in the database.
 *
 * Every ticket code is exactly seven lowercase characters, in one of two
 * shapes: a letter, a hyphen and five alphanumerics (`x-abc12`), or seven
 * alphanumerics (`xyabc12`). `src/constants/ticket.ts` is the source of truth
 * and the service validates against it before any write. This constraint is the
 * backstop for a write that bypasses the service, such as a hand-typed `INSERT`
 * in `psql`, so a malformed code cannot enter the table and lock its holder out
 * of check-in.
 *
 * The pattern is written out literally rather than imported: a migration is a
 * snapshot that has to keep running unchanged, so it does not follow later
 * edits to that module. Both shapes fold into one expression, a prefix that is
 * either a letter and a hyphen or two alphanumerics, then five alphanumerics.
 *
 * `up` fails if any existing row does not match, which is intended: rewriting a
 * ticket code silently would invalidate passes already issued. Purge or reissue
 * those rows first.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

export const up = (pgm: MigrationBuilder): void => {
  pgm.addConstraint('attendees', 'attendees_ticket_code_format', {
    check: "ticket_code ~ '^([a-z]-|[a-z0-9]{2})[a-z0-9]{5}$'",
  });
};

/** Drops the constraint, leaving the format to the service alone. */
export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('attendees', 'attendees_ticket_code_format');
};
