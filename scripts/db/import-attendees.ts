/**
 * Loads the sign-up system's roster CSV into `attendees` for the current event.
 *
 * Usage, from the repo root — the file is read from stdin, so it never has to
 * be copied into the container:
 *
 *   docker compose run --rm -T migrate node scripts/db/import-attendees.ts --dry-run < roster.csv
 *   docker compose run --rm -T migrate node scripts/db/import-attendees.ts < roster.csv
 *
 * Header — `ticket_code`, `name` and `phone` required, the rest optional, any
 * order:
 *
 *   ticket_code,name,phone,role,meal_option,drink_option,tshirt_size,lunch_option,tshirt_volunteer_size,team,team_role,checkin_time
 *   xabc12,Ana Lima,+55 (11) 90000-1234,,Hambúrguer de Carne,,M - Preto,,,,,
 *
 * A blank `role` is taken from the code (`v` is a volunteer); a blank option
 * means no entitlement to that item, and `lunch_option` and
 * `tshirt_volunteer_size` are refused on a participant. `team`, `team_role` and
 * `checkin_time` are loaded here too, for volunteers only; a column left out of
 * the header is not touched, while a blank cell under it clears the value.
 * Volunteer permissions are not set here — see `set-volunteer-permissions.ts`.
 * Full column reference: `docs/operations/imports.md`.
 *
 * **Safe to repeat.** `ticket_code` is the identity: a code nobody holds is
 * inserted, a known code has only its changed registration fields updated, and
 * a code the file no longer lists is reported and left alone. The rules, and
 * what an import will never touch, are in `admin.attendees.import.ts`.
 *
 * **All or nothing.** Every row is validated, and every row read back and
 * planned, before the first write, all inside one transaction. Any problem
 * rolls the whole load back. `--dry-run` runs everything and rolls back anyway.
 *
 * Connects as the migrator role, like `seed.ts` and the admin CLI — see
 * `scripts/admin/db.ts`. No production guard, unlike `seed.ts`: production is
 * what this is for, and `--dry-run` is the safety.
 */

import { argv, env as processEnv, exit, stdin } from 'node:process';

import { db } from '../admin/db.ts';

import { readImportInput } from '../../src/modules/admin/admin.import-input.ts';
import {
  parseRosterCsv,
  planImport,
} from '../../src/modules/admin/admin.attendees.import.ts';

import type { PoolClient } from 'pg';

import type {
  ExistingAttendee,
  ImportField,
  ImportPlan,
  RosterRow,
} from '../../src/modules/admin/admin.attendees.import.ts';

/**
 * Rows per `INSERT`.
 *
 * Thirteen parameters a row against Postgres' 65,535-parameter ceiling; a roster
 * of hundreds is one statement, and this only stops a larger one from failing.
 */
const INSERT_BATCH = 1_000;

/** Columns an inserted row names, as migration 016 grants them. */
const INSERT_COLUMNS = [
  'event_id',
  'ticket_code',
  'attendee_role',
  'attendee_name',
  'attendee_phone',
  'meal_option',
  'drink_option',
  'tshirt_size',
  'lunch_option',
  'tshirt_volunteer_size',
  'team',
  'team_role',
  'checkin_time',
] as const;

/**
 * Reads a `--flag` switch.
 *
 * @param name - Flag name, without the dashes.
 */
const switched = (name: string): boolean => argv.includes(`--${name}`);

/**
 * Prints a list of lines under a heading, or nothing if it is empty.
 *
 * @param heading - What the lines are.
 * @param lines - One entry each.
 */
const list = (heading: string, lines: readonly string[]): void => {
  if (lines.length === 0) return;

  console.log(`\n  ${heading}:`);

  for (const line of lines) console.log(`    ${line}`);
};

/**
 * Inserts new attendees in batches.
 *
 * `attendee_id`, `ticket_link_token` and `created_at` are left to their
 * defaults, so every row gets a fresh entry-link token exactly as one created
 * in the editor does.
 *
 * @param client - Connection holding the open transaction.
 * @param rows - Rows to insert.
 * @param eventId - Event they belong to.
 */
const insertRows = async (
  client: PoolClient,
  rows: readonly RosterRow[],
  eventId: string,
): Promise<void> => {
  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    const params: unknown[] = [];

    const values = rows.slice(start, start + INSERT_BATCH).map((row) => {
      params.push(
        eventId,
        row.ticketCode,
        row.role,
        row.fields.attendee_name,
        row.fields.attendee_phone,
        row.fields.meal_option,
        row.fields.drink_option,
        row.fields.tshirt_size,
        row.fields.lunch_option,
        row.fields.tshirt_volunteer_size,
        row.fields.team ?? null,
        row.fields.team_role ?? null,
        row.fields.checkin_time ?? null,
      );

      const first = params.length - INSERT_COLUMNS.length + 1;

      return `(${INSERT_COLUMNS.map((_, index) => `$${String(first + index)}`).join(', ')})`;
    });

    await client.query(
      `INSERT INTO attendees (${INSERT_COLUMNS.join(', ')})
      VALUES ${values.join(',\n        ')}`,
      params,
    );
  }
};

/**
 * Writes the changed fields of one attendee.
 *
 * Only the changed columns are named. Column names come from the fixed
 * {@link ImportField} set, never from the file. `updated_at` is stamped by the
 * `attendees_set_updated_at` trigger from migration 006.
 *
 * @param client - Connection holding the open transaction.
 * @param attendeeId - Row to update.
 * @param row - The roster values.
 * @param changed - Which fields differ.
 */
const updateRow = async (
  client: PoolClient,
  attendeeId: string,
  row: RosterRow,
  changed: readonly ImportField[],
): Promise<void> => {
  const assignments = changed.map(
    (field, index) => `${field} = $${String(index + 2)}`,
  );

  await client.query(
    `UPDATE attendees SET ${assignments.join(', ')} WHERE attendee_id = $1`,
    [attendeeId, ...changed.map((field) => row.fields[field])],
  );
};

/**
 * Reports what the load did, or would have done.
 *
 * Ticket codes and line numbers only; see `admin.attendees.import.ts`.
 *
 * @param plan - The executed plan.
 * @param warnings - Non-fatal findings from the file.
 * @param dryRun - Whether the writes were rolled back.
 */
const report = (
  plan: ImportPlan,
  warnings: readonly string[],
  dryRun: boolean,
): void => {
  const verb = dryRun ? 'Would import' : 'Imported';

  console.log(
    `\n✓ ${verb}: ${String(plan.inserts.length)} inserted, ${String(plan.updates.length)} updated, ${String(plan.unchanged)} unchanged`,
  );

  list(
    'Updated',
    plan.updates.map(
      (update) =>
        `line ${String(update.row.line)} (${update.row.ticketCode}): ${update.changed.join(', ')}`,
    ),
  );
  list(
    'Phone changed — the verification code is now its last four digits',
    plan.updates
      .filter((update) => update.changed.includes('attendee_phone'))
      .map((update) => update.row.ticketCode),
  );
  list(
    'Updated after check-in',
    plan.updates
      .filter((update) => update.checkedIn)
      .map((update) => update.row.ticketCode),
  );
  list(
    'Updated while archived — still archived',
    plan.updates
      .filter((update) => update.archived)
      .map((update) => update.row.ticketCode),
  );
  list(
    'Not in this file — left unchanged; archive in the editor if cancelled',
    plan.missing,
  );
  list('Warnings', warnings);

  if (dryRun) console.log('\n  Dry run: nothing was written.');
};

/**
 * Prints problems and fails the run.
 *
 * @param problems - Everything that stopped the load.
 * @throws {Error} Always.
 */
const refuse = (problems: readonly string[]): never => {
  list('Problems', problems);

  throw new Error(
    `Nothing imported: ${String(problems.length)} problem(s) listed above`,
  );
};

const main = async (): Promise<void> => {
  const eventId = processEnv.EVENT_ID;

  if (!eventId) {
    throw new Error(
      'Missing environment variable: EVENT_ID — every attendee row is scoped to it',
    );
  }

  if (stdin.isTTY) {
    throw new Error(
      'Pipe the roster in: node scripts/db/import-attendees.ts [--dry-run] < roster.csv',
    );
  }

  const dryRun = switched('dry-run');
  const parsed = parseRosterCsv(await readImportInput(stdin));

  if (parsed.problems.length > 0) refuse(parsed.problems);

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Every row under this event, for the missing list, plus any row the file
    // names under another event, because ticket_code is unique table-wide.
    // Locked so the editor cannot change a row between this read and the write.
    const existing = await client.query<ExistingAttendee>(
      `SELECT attendee_id, event_id, ticket_code, attendee_role,
          checkin_complete, archived_at,
          attendee_name, attendee_phone,
          meal_option, drink_option, tshirt_size, lunch_option,
          tshirt_volunteer_size, team, team_role, checkin_time,
          meal_redeemed_at, drink_redeemed_at, tshirt_redeemed_at,
          lunch_redeemed_at, tshirt_volunteer_redeemed_at
        FROM attendees
        WHERE event_id = $1 OR ticket_code = ANY($2)
        FOR UPDATE`,
      [eventId, parsed.rows.map((row) => row.ticketCode)],
    );

    const plan = planImport(parsed.rows, existing.rows, eventId);

    if (plan.problems.length > 0) refuse(plan.problems);

    await insertRows(client, plan.inserts, eventId);

    for (const update of plan.updates) {
      await updateRow(client, update.attendeeId, update.row, update.changed);
    }

    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');

    report(plan, parsed.warnings, dryRun);
  } catch (err) {
    await client.query('ROLLBACK');

    throw err;
  } finally {
    client.release();
  }
};

try {
  await main();
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);

  exit(1);
} finally {
  await db.end();
}
