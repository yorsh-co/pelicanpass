import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Widens ticket_code so volunteer codes can carry five characters after their
 * prefix.
 *
 * Volunteer codes were `v-` plus three characters — 36^3 = 46,656 possibilities,
 * small enough to enumerate through the check-in endpoint within an event
 * window. `v-` plus five is 36^5 = 60,466,176 and removes that. The prefix stays
 * because participant codes come from an external system and follow no pattern
 * beyond five lowercase alphanumerics, so it is the only guarantee of
 * non-collision.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

export const up = (pgm: MigrationBuilder): void => {
  pgm.alterColumn('attendees', 'ticket_code', { type: 'varchar(7)' });
};

/**
 * Narrows the column back to varchar(5).
 *
 * This fails outright if any seven-character volunteer code has been issued,
 * which is the intended behaviour — silently truncating a ticket code would
 * lock the attendee holding it out of check-in. Delete or re-issue those rows
 * before rolling back.
 */
export const down = (pgm: MigrationBuilder): void => {
  pgm.alterColumn('attendees', 'ticket_code', { type: 'varchar(5)' });
};
