/**
 * Sets volunteer permissions — `can_redeem`, `redeem_scopes`, `can_draw` — and
 * the pass's `show_admin_link` and `admin_username`, in bulk from a CSV, for
 * the current event.
 *
 * Usage, from the repo root — the file is read from stdin, so it never has to
 * be copied into the container:
 *
 *   docker compose run --rm -T migrate node scripts/db/set-volunteer-permissions.ts --dry-run < permissions.csv
 *   docker compose run --rm -T migrate node scripts/db/set-volunteer-permissions.ts < permissions.csv
 *
 * Header — `ticket_code` plus at least one permission column, any order:
 *
 *   ticket_code,can_redeem,redeem_scopes,can_draw,show_admin_link,admin_username
 *   vab123,true,meal;drink,false,false,consulta.ana
 *
 * Flags are `true` / `false`; `show_admin_link` only puts a link to `/admin` on
 * the pass, which still asks for its own login. `redeem_scopes` is
 * `;`-separated `tshirt`, `tshirt_volunteer`, `meal`, `drink`, `lunch`, or
 * `none`. `admin_username` names the volunteer's existing administrator
 * account, a label that grants nothing; a disabled account is loaded with a
 * warning. A blank `admin_username` clears the link. A column left out of the
 * header is not touched, and neither is a volunteer left out of the file.
 * `team`, `team_role` and `checkin_time` are loaded by the roster import
 * (`import-attendees.ts`), not here. Full reference: `docs/operations/imports.md`.
 *
 * **Separate from the roster import on purpose**, so re-loading the sign-up
 * export can never change anyone's access. The rules are in
 * `admin.volunteer-permissions.import.ts`.
 *
 * **All or nothing.** Every row is validated and planned before the first
 * write, inside one transaction; any problem rolls the whole load back.
 * `--dry-run` runs everything and rolls back anyway.
 *
 * Connects as the migrator role: migrations 008, 010, 011, 022 and 031 withhold
 * `UPDATE` on these columns from the application role. See `scripts/admin/db.ts`.
 */

import { argv, env as processEnv, exit, stdin } from 'node:process';

import { db } from '../admin/db.ts';
import { readImportInput } from '../../src/modules/admin/admin.import-input.ts';

import {
  NO_SCOPES,
  SCOPE_SEPARATOR,
  parsePermissionsCsv,
  planPermissions,
} from '../../src/modules/admin/admin.volunteer-permissions.import.ts';

import type { PoolClient } from 'pg';

import type {
  ExistingVolunteer,
  PermissionField,
  PermissionPlan,
  PlannedPermissionUpdate,
} from '../../src/modules/admin/admin.volunteer-permissions.import.ts';

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
 * Renders a permission value as the file would spell it.
 *
 * @param value - A flag, a scope list, or a label, `null` when cleared.
 */
const spell = (value: boolean | string | readonly string[] | null): string => {
  if (value === null) return '(blank)';
  if (typeof value === 'boolean' || typeof value === 'string') {
    return String(value);
  }

  return value.length === 0 ? NO_SCOPES : value.join(SCOPE_SEPARATOR);
};

/**
 * Writes the changed permissions of one volunteer.
 *
 * Column names come from the fixed {@link PermissionField} set, never from the
 * file.
 *
 * @param client - Connection holding the open transaction.
 * @param update - The planned change.
 */
const updateRow = async (
  client: PoolClient,
  update: PlannedPermissionUpdate,
): Promise<void> => {
  const assignments = update.changed.map(
    (field, index) => `${field} = $${String(index + 2)}`,
  );

  await client.query(
    `UPDATE attendees SET ${assignments.join(', ')} WHERE attendee_id = $1`,
    [
      update.attendeeId,
      ...update.changed.map((field) => update.row.values[field]),
    ],
  );
};

/**
 * Describes one field's change, old to new.
 *
 * @param update - The planned change.
 * @param field - One of its changed fields.
 */
const describeChange = (
  update: PlannedPermissionUpdate,
  field: PermissionField,
): string =>
  `${field} ${spell(update.before[field])} → ${spell(update.row.values[field] ?? null)}`;

/**
 * Reports what the load did, or would have done. Ticket codes only.
 *
 * @param plan - The executed plan.
 * @param dryRun - Whether the writes were rolled back.
 */
const report = (plan: PermissionPlan, dryRun: boolean): void => {
  const verb = dryRun ? 'Would set' : 'Set';

  console.log(
    `\n✓ ${verb}: ${String(plan.updates.length)} updated, ${String(plan.unchanged)} unchanged`,
  );

  list(
    'Updated',
    plan.updates.map(
      (update) =>
        `line ${String(update.row.line)} (${update.row.ticketCode}): ${update.changed.map((field) => describeChange(update, field)).join(', ')}`,
    ),
  );
  list('Warnings', plan.warnings);
  list(
    'Access removed — takes effect on their next request',
    plan.updates
      .filter((update) => update.revoked)
      .map((update) => update.row.ticketCode),
  );
  list(
    'Updated while archived — still archived',
    plan.updates
      .filter((update) => update.archived)
      .map((update) => update.row.ticketCode),
  );

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
    `Nothing written: ${String(problems.length)} problem(s) listed above`,
  );
};

const main = async (): Promise<void> => {
  const eventId = processEnv.EVENT_ID;

  if (!eventId) {
    throw new Error(
      'Missing environment variable: EVENT_ID — only volunteers under it are touched',
    );
  }

  if (stdin.isTTY) {
    throw new Error(
      'Pipe the file in: node scripts/db/set-volunteer-permissions.ts [--dry-run] < permissions.csv',
    );
  }

  const dryRun = switched('dry-run');
  const parsed = parsePermissionsCsv(await readImportInput(stdin));

  if (parsed.problems.length > 0) refuse(parsed.problems);

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Every row the file names, under any event, so a code held elsewhere is
    // refused rather than reported unknown. Locked against the editor.
    const existing = await client.query<ExistingVolunteer>(
      `SELECT attendee_id, event_id, ticket_code, attendee_role, archived_at,
          can_redeem, redeem_scopes, can_draw, show_admin_link,
          admin_username
        FROM attendees
        WHERE ticket_code = ANY($1)
        FOR UPDATE`,
      [parsed.rows.map((row) => row.ticketCode)],
    );

    const admins = await client.query<{ username: string; is_active: boolean }>(
      'SELECT username, is_active FROM admins',
    );

    const plan = planPermissions(
      parsed.rows,
      existing.rows,
      eventId,
      new Map(
        admins.rows.map((admin) => [
          admin.username,
          { isActive: admin.is_active },
        ]),
      ),
    );

    if (plan.problems.length > 0) refuse(plan.problems);

    for (const update of plan.updates) await updateRow(client, update);

    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');

    report(plan, dryRun);
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
