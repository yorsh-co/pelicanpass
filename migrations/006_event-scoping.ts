import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Makes `event_id` a real constraint rather than an unused column.
 *
 * `env.eventId` reached the check-in session and never a query, so every read
 * path returned any attendee holding a matching ticket regardless of event.
 * The repository now filters on it, which is what makes the index and the
 * `NOT NULL` worth having.
 *
 * **No column default**, so every insert has to name `event_id`. A default
 * would silently land forgotten rows under whichever event was current when
 * this migration ran; a not-null violation is loud and immediate.
 *
 * The `updated_at` trigger rides along because it touches the same table.
 * `completeCheckin` already sets the column by hand, so this only affects
 * writes made outside the application.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Reads the event identifier used to backfill rows that predate this migration.
 *
 * Interpolated into SQL as a literal rather than bound as a parameter, because
 * node-pg-migrate collects statements as text. The character class is what
 * makes that safe — it admits UUIDs and slugs and rejects anything that could
 * terminate the surrounding quotes.
 *
 * @returns The validated event identifier.
 * @throws {Error} If the variable is unset or contains unexpected characters.
 */
const eventId = (): string => {
  const value = process.env.EVENT_ID;

  if (!value) {
    throw new Error(
      'EVENT_ID must be set: existing attendees are backfilled with it',
    );
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`EVENT_ID contains unexpected characters: ${value}`);
  }

  return value;
};

export const up = (pgm: MigrationBuilder): void => {
  // Before the trigger exists, so the backfill does not stamp updated_at across
  // the whole table.
  pgm.sql(
    `UPDATE attendees SET event_id = '${eventId()}' WHERE event_id IS NULL`,
  );

  pgm.alterColumn('attendees', 'event_id', { notNull: true });

  pgm.createIndex('attendees', 'event_id');

  pgm.createFunction(
    'set_updated_at',
    [],
    { returns: 'trigger', language: 'plpgsql', replace: true },
    `BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;`,
  );

  pgm.createTrigger('attendees', 'attendees_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTrigger('attendees', 'attendees_set_updated_at');
  pgm.dropFunction('set_updated_at', []);
  pgm.dropIndex('attendees', 'event_id');

  // The backfilled values stay. Dropping the constraint is reversible; deciding
  // which rows were originally null is not.
  pgm.alterColumn('attendees', 'event_id', { notNull: false });
};
