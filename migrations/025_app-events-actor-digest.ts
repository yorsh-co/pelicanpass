import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Replaces the raw session IDs already stored in `app_events.actor_id` with the
 * digest handle the application now writes.
 *
 * `actorOf` used to store the session ID itself: a bearer credential, readable
 * by the readonly role for as long as `TELEMETRY_EVENT_RETENTION` keeps the row
 * — longer than an attendee session lives. It now stores the first 16 hex
 * characters of the ID's SHA-256, and this derives the same value in SQL, so a
 * session's rows from before and after the change still correlate.
 *
 * Scoped to what `actorOf` wrote. `domain` rows carry an `admins.admin_id` —
 * also a UUID, and not a credential — set explicitly by the services that
 * record them, and are left alone. Nothing a digest produces is UUID-shaped, so
 * running the statement again changes nothing; that makes it safe to repeat by
 * hand for rows an old process wrote between this migration and its restart.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    UPDATE app_events
       SET actor_id = left(encode(sha256(convert_to(actor_id, 'UTF8')), 'hex'), 16)
     WHERE kind <> 'domain'
       AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  `);
};

/**
 * Does nothing, rather than `down = false`: that would make every rollback past
 * this migration throw. Rolling back the application code alone is safe — it
 * resumes writing raw IDs beside the digests.
 */
export const down = (): void => {
  // A digest cannot be turned back into the session ID; that is the point.
};
