import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Creates the record of which check-in numbers the raffle has called.
 *
 * `checkin_number` has always existed for the draw — it is on the pass in
 * six-rem type, labelled for the raffle, and volunteers carry none precisely so
 * they are excluded from it. What has never existed is a record of what was
 * called. This table is that record, and it is what lets a raffle survive the
 * operator's phone reloading mid-event.
 *
 * **A reset is a soft clear, not a delete.** Taking a number back — the winner
 * has gone home, the ticket was misread — stamps `cleared_at` and `cleared_by`
 * rather than removing the row, and the application is granted no `DELETE` at
 * all. The number returns to the pool because every query filters on
 * `cleared_at IS NULL`, and the history of what was called and what was put
 * back survives for `pelicanpass_readonly` to answer questions from afterwards.
 *
 * **`SELECT` is granted here where `redemptions` withholds it.** That table is
 * an audit trail the application should be blind to; this one is operational
 * state the page reads back on every load. The two are different things and are
 * granted differently on purpose. It also means the insert can use `RETURNING`,
 * which `redemptions` cannot.
 *
 * **No `updated_at` and no `set_updated_at` trigger.** `cleared_at` is the only
 * modification this table admits and is itself the time it happened; a second
 * timestamp could only ever disagree with it.
 *
 * **No unique constraint on `(event_id, checkin_number)`.** With repeats
 * allowed a number can legitimately be called twice, and a constraint would
 * reject exactly the row that records it.
 *
 * **No foreign keys**, matching the rest of the schema, which has none. The
 * purge scripts redact rather than delete, so referential integrity is never
 * under threat from teardown.
 *
 * A new table is invisible to the application until it is granted: there is no
 * table-level default privilege for the application role, deliberately
 * (`scripts/db/init/01-roles.sh`), so a missing grant surfaces as a 500 at the
 * first real query and nowhere earlier — not at migrate time, not at typecheck.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Columns the application reads back.
 *
 * Named rather than granted table-wide so `SELECT *` fails against the
 * application role here as it does on `attendees` — a column added later is
 * invisible until somebody decides it should not be.
 */
const SELECTABLE_COLUMNS = [
  'draw_id',
  'event_id',
  'checkin_number',
  'drawn_by',
  'created_at',
  'cleared_at',
  'cleared_by',
].join(', ');

/**
 * Columns the application supplies on a draw.
 *
 * `draw_id` and `created_at` carry defaults and are never written by hand, and
 * the two `cleared_*` columns are an update rather than an insert — granting
 * any of them here would widen the insert for no caller.
 */
const INSERTABLE_COLUMNS = ['event_id', 'checkin_number', 'drawn_by'].join(
  ', ',
);

/** The only columns a reset may write. */
const CLEARABLE_COLUMNS = ['cleared_at', 'cleared_by'].join(', ');

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

  pgm.createTable('raffle_draws', {
    draw_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    event_id: { type: 'text', notNull: true },

    // The number that was called. Not the attendee: the draw knows a number and
    // nothing else, and working out who holds it is the staff surface's job.
    checkin_number: { type: 'integer', notNull: true },

    // The operator's attendee_id, never their check-in number — the volunteers
    // who run a draw have none.
    drawn_by: { type: 'uuid', notNull: true },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },

    // Null means the number is still standing. Written together, always.
    cleared_at: { type: 'timestamptz' },
    cleared_by: { type: 'uuid' },
  });

  // Every query this table serves is "the standing draws for this event, newest
  // first". At event scale a sequential scan would serve; it is here because
  // the page reloads this list after every draw and every reset, on a stage.
  pgm.createIndex('raffle_draws', ['event_id', 'created_at']);

  pgm.sql(`GRANT SELECT (${SELECTABLE_COLUMNS}) ON raffle_draws TO ${role}`);
  pgm.sql(`GRANT INSERT (${INSERTABLE_COLUMNS}) ON raffle_draws TO ${role}`);
  pgm.sql(`GRANT UPDATE (${CLEARABLE_COLUMNS}) ON raffle_draws TO ${role}`);
};

export const down = (pgm: MigrationBuilder): void => {
  // Every grant this migration made is on its own table, and table privileges
  // are dropped with the table — unlike 009, there is nothing to revoke by hand.
  pgm.dropTable('raffle_draws');
};
