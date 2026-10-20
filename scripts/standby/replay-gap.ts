/**
 * Replays the failover "gap" onto the warm standby: the check-ins and
 * redemptions the primary (prod-server) recorded after the restored snapshot's
 * `taken_at`, which dev-server never saw.
 *
 * Usage, from the repo root — the gap is read from stdin as JSON, produced by
 * the wrapper that extracts it from prod-server:
 *
 *   docker compose run --rm -T migrate node scripts/standby/replay-gap.ts --number-floor 1100 --dry-run < gap.json
 *   docker compose run --rm -T migrate node scripts/standby/replay-gap.ts --number-floor 1100 < gap.json
 *
 * `--number-floor` is the restored `checkin_number_last` plus the reserve: every
 * number in the gap must be at or below it, so dev-server, which issues above it,
 * can never have issued one of them. The input format is validated in
 * `gap-input.ts`, and what to write is decided in `gap-plan.ts`; this file only
 * reads dev-server's state under locks, writes the plan and reports it.
 *
 * **Safe to repeat.** A check-in already in place and a redemption row dev-server
 * already holds (same `redemption_id`) are not written again, and a re-run
 * reports no changes.
 *
 * **All or nothing.** Everything happens in one transaction; any problem rolls
 * it back. `--dry-run` runs everything and rolls back anyway.
 *
 * Connects as the migrator role — see `scripts/admin/db.ts`. Reports name
 * ticket codes and items, never names or phones.
 */

import { argv, env as processEnv, exit, stdin } from 'node:process';

import { db } from '../admin/db.ts';

import { parseGap } from './gap-input.ts';
import { REDEMPTION_ITEMS, planGap } from './gap-plan.ts';

import type { PoolClient } from 'pg';

import type { RedemptionItem } from '../../src/constants/pass.ts';
import type {
  Gap,
  GapPlan,
  Standby,
  StandbyActivity,
  StandbyAttendee,
} from './gap-plan.ts';

/** Largest gap accepted on stdin. A real gap is a few hundred kilobytes. */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

/** Rows per `INSERT`: nine parameters a row against the 65,535 ceiling. */
const INSERT_BATCH = 1_000;

/**
 * The `*_redeemed_at` column of each item. The only source of column names in
 * the SQL below; mirrors `ITEM_COLUMNS` in the redemptions repository, which is
 * not imported because it pulls in the app's environment.
 */
const REDEEMED_AT: Record<RedemptionItem, string> = {
  tshirt: 'tshirt_redeemed_at',
  meal: 'meal_redeemed_at',
  drink: 'drink_redeemed_at',
  lunch: 'lunch_redeemed_at',
  tshirt_volunteer: 'tshirt_volunteer_redeemed_at',
};

/** An attendee row as the lock query returns it. */
interface AttendeeRow {
  attendee_id: string;
  ticket_code: string;
  attendee_role: 'participant' | 'volunteer';
  archived: boolean;
  checkin_complete: boolean;
  checkin_number: number | null;
  checkin_at: Date | null;
  tshirt_redeemed_at: Date | null;
  meal_redeemed_at: Date | null;
  drink_redeemed_at: Date | null;
  lunch_redeemed_at: Date | null;
  tshirt_volunteer_redeemed_at: Date | null;
}

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
 * Prints problems and fails the run.
 *
 * @param problems - Everything that stopped the replay.
 * @throws {Error} Always.
 */
const refuse = (problems: readonly string[]): never => {
  list('Problems', problems);

  throw new Error(
    `Nothing written: ${String(problems.length)} problem(s) listed above`,
  );
};

/**
 * Reads `--number-floor`.
 *
 * @returns The floor, as a non-negative integer.
 * @throws {Error} If the flag is missing or not a non-negative integer.
 */
const readNumberFloor = (): number => {
  const index = argv.indexOf('--number-floor');
  const value = index === -1 ? undefined : argv[index + 1];

  if (value === undefined || !/^\d{1,15}$/.test(value)) {
    throw new Error(
      '--number-floor N is required: the restored checkin_number_last plus the reserve, as a non-negative integer',
    );
  }

  return Number(value);
};

/**
 * Reads stdin up to {@link MAX_INPUT_BYTES}, and stops reading there.
 *
 * @throws {Error} If the input is larger.
 */
const readInput = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);

    size += buffer.length;

    if (size > MAX_INPUT_BYTES) {
      throw new Error(
        `Input is larger than ${String(MAX_INPUT_BYTES / 1024 / 1024)} MB`,
      );
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
};

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

const unique = (values: Iterable<string>): string[] => [...new Set(values)];

/**
 * Reads dev-server's side of the gap, scoped to the event.
 *
 * The attendee rows are locked, so a check-in or a redemption on dev-server cannot
 * land between this read and the writes. `heldNumbers` spans every event,
 * because `checkin_number` is unique table-wide.
 *
 * @param client - Connection holding the open transaction.
 * @param gap - The validated gap.
 * @param eventId - Event the replay is for.
 * @param numberFloor - The `--number-floor` value.
 */
const readStandby = async (
  client: PoolClient,
  gap: Gap,
  eventId: string,
  numberFloor: number,
): Promise<Standby> => {
  const codes = unique([
    ...gap.checkins.map((c) => c.ticketCode),
    ...gap.redemptions.map((r) => r.ticketCode),
    ...gap.created,
  ]);
  const attendeeIds = unique([
    ...gap.checkins.map((c) => c.attendeeId),
    ...gap.redemptions.map((r) => r.attendeeId),
  ]);
  const numbers = gap.checkins.flatMap((c) =>
    c.checkinNumber === null ? [] : [c.checkinNumber],
  );
  const redemptionIds = gap.redemptions.map((r) => r.redemptionId);

  const attendees = await client.query<AttendeeRow>(
    `SELECT attendee_id, ticket_code, attendee_role,
        archived_at IS NOT NULL AS archived,
        checkin_complete, checkin_number, checkin_at,
        ${REDEMPTION_ITEMS.map((item) => REDEEMED_AT[item]).join(', ')}
      FROM attendees
      WHERE event_id = $1
        AND ticket_code = ANY($2::text[])
      FOR UPDATE`,
    [eventId, codes],
  );

  const held = await client.query<{
    checkin_number: number;
    ticket_code: string;
  }>(
    `SELECT checkin_number, ticket_code
      FROM attendees
      WHERE checkin_number = ANY($1::int[])`,
    [numbers],
  );

  const own = await client.query<{
    redemption_id: string;
    ticket_code: string;
    item: RedemptionItem;
    outcome: string;
    created_at: Date;
  }>(
    `SELECT r.redemption_id, a.ticket_code, r.item, r.outcome, r.created_at
      FROM redemptions r
      JOIN attendees a
        ON a.attendee_id = r.attendee_id
       AND a.event_id = r.event_id
      WHERE r.event_id = $1
        AND r.attendee_id = ANY($2::uuid[])
        AND r.created_at > $3::timestamptz
        AND r.outcome IN ('redeemed', 'marked', 'reverted')`,
    [eventId, attendeeIds, gap.takenAt],
  );

  const replayed = await client.query<{ redemption_id: string }>(
    `SELECT redemption_id
      FROM redemptions
      WHERE redemption_id = ANY($1::uuid[])`,
    [redemptionIds],
  );

  const draws = await client.query<{ draws: number }>(
    `SELECT count(*)::int AS draws
      FROM raffle_draws
      WHERE event_id = $1
        AND created_at > $2::timestamptz`,
    [eventId, gap.takenAt],
  );

  return {
    numberFloor,
    attendees: attendees.rows.map((row): StandbyAttendee => ({
      attendeeId: row.attendee_id,
      ticketCode: row.ticket_code,
      role: row.attendee_role,
      archived: row.archived,
      checkinComplete: row.checkin_complete,
      checkinNumber: row.checkin_number,
      checkinAt: iso(row.checkin_at),
      redeemedAt: {
        tshirt: iso(row.tshirt_redeemed_at),
        meal: iso(row.meal_redeemed_at),
        drink: iso(row.drink_redeemed_at),
        lunch: iso(row.lunch_redeemed_at),
        tshirt_volunteer: iso(row.tshirt_volunteer_redeemed_at),
      },
    })),
    heldNumbers: held.rows.map((row) => ({
      checkinNumber: row.checkin_number,
      ticketCode: row.ticket_code,
    })),
    ownActivity: own.rows.map((row): StandbyActivity => ({
      redemptionId: row.redemption_id,
      ticketCode: row.ticket_code,
      item: row.item,
      outcome: row.outcome,
      createdAt: row.created_at.toISOString(),
    })),
    replayedIds: replayed.rows.map((row) => row.redemption_id),
    drawsSinceTakenAt: draws.rows[0]?.draws ?? 0,
  };
};

/**
 * Runs one single-row `UPDATE`, failing if it did not touch exactly one row.
 *
 * @param client - Connection holding the open transaction.
 * @param sql - Statement text, built only from constants.
 * @param params - Statement parameters.
 * @param what - What is being written, for the error.
 */
const updateOne = async (
  client: PoolClient,
  sql: string,
  params: unknown[],
  what: string,
): Promise<void> => {
  const result = await client.query(sql, params);

  if (result.rowCount !== 1) {
    throw new Error(
      `${what}: expected one row to change, not ${String(result.rowCount)}`,
    );
  }
};

/**
 * Writes the plan: check-ins, then redemption rows, then item state.
 *
 * Mirrors the application's own writes — `completeCheckin` for a check-in and
 * `correctRedemption` for item state — except that the number, times and ids
 * are prod-server's. Column names come from {@link REDEEMED_AT}, never from the
 * input.
 *
 * @param client - Connection holding the open transaction.
 * @param plan - What to write.
 * @param eventId - Event the replay is for.
 */
const writePlan = async (
  client: PoolClient,
  plan: GapPlan,
  eventId: string,
): Promise<void> => {
  for (const checkin of plan.checkins) {
    await updateOne(
      client,
      `UPDATE attendees
      SET checkin_complete = TRUE,
        checkin_at = $1,
        checkin_number = $2,
        updated_at = NOW()
      WHERE attendee_id = $3
        AND event_id = $4`,
      [checkin.checkinAt, checkin.checkinNumber, checkin.attendeeId, eventId],
      `${checkin.ticketCode} check-in`,
    );
  }

  for (
    let start = 0;
    start < plan.redemptionInserts.length;
    start += INSERT_BATCH
  ) {
    const params: unknown[] = [];

    const values = plan.redemptionInserts
      .slice(start, start + INSERT_BATCH)
      .map((row) => {
        params.push(
          row.redemptionId,
          eventId,
          row.attendeeId,
          row.item,
          row.outcome,
          row.redeemedBy,
          row.actorType,
          row.reason,
          row.createdAt,
        );

        const first = params.length - 9 + 1;

        return `(${Array.from({ length: 9 }, (_, index) => `$${String(first + index)}`).join(', ')})`;
      });

    await client.query(
      `INSERT INTO redemptions
        (redemption_id, event_id, attendee_id, item, outcome, redeemed_by,
         actor_type, reason, created_at)
      VALUES ${values.join(',\n        ')}
      ON CONFLICT (redemption_id) DO NOTHING`,
      params,
    );
  }

  for (const update of plan.itemUpdates) {
    await updateOne(
      client,
      `UPDATE attendees
      SET ${REDEEMED_AT[update.item]} = $1
      WHERE attendee_id = $2
        AND event_id = $3`,
      [update.redeemedAt, update.attendeeId, eventId],
      `${update.ticketCode} ${update.item}`,
    );
  }
};

/**
 * Reports what the replay did, or would have done.
 *
 * Ticket codes and items only.
 *
 * @param plan - The executed plan.
 * @param dryRun - Whether the writes were rolled back.
 */
const report = (plan: GapPlan, dryRun: boolean): void => {
  const verb = dryRun ? 'Would replay' : 'Replayed';
  const unchanged = plan.unchanged.checkins + plan.unchanged.items;

  console.log(
    `\n✓ ${verb}: ${String(plan.checkins.length)} check-ins, ${String(plan.redemptionInserts.length)} redemption rows, ${String(plan.itemUpdates.length)} item states (${String(unchanged)} unchanged)`,
  );

  list(
    'Checked in',
    plan.checkins.map(
      (c) =>
        `${c.ticketCode}${c.checkinNumber === null ? '' : ` #${String(c.checkinNumber)}`}`,
    ),
  );
  list(
    'Redemption rows',
    plan.redemptionInserts.map((r) => `${r.ticketCode} ${r.item} ${r.outcome}`),
  );
  list(
    'Item state set',
    plan.itemUpdates.map(
      (u) =>
        `${u.ticketCode} ${u.item} → ${u.redeemedAt === null ? 'not collected' : 'collected'}`,
    ),
  );

  for (const { heading, lines } of plan.notices) list(heading, lines);

  if (dryRun) console.log('\n  Dry run: nothing was written.');
};

const main = async (): Promise<void> => {
  const eventId = processEnv.EVENT_ID;

  if (!eventId) {
    throw new Error(
      'Missing environment variable: EVENT_ID — every attendee row is scoped to it',
    );
  }

  const usage =
    'node scripts/standby/replay-gap.ts --number-floor N [--dry-run] < gap.json';

  if (stdin.isTTY) throw new Error(`Pipe the gap in: ${usage}`);

  const unknown = argv
    .slice(2)
    .filter(
      (arg, index, args) =>
        !['--dry-run', '--number-floor'].includes(arg) &&
        args[index - 1] !== '--number-floor',
    );

  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown[0] ?? ''}. Usage: ${usage}`);
  }

  const numberFloor = readNumberFloor();
  const dryRun = argv.includes('--dry-run');
  const parsed = parseGap(await readInput());

  if ('problems' in parsed) refuse(parsed.problems);

  const { gap } = parsed as { gap: Gap };
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const standby = await readStandby(client, gap, eventId, numberFloor);
    const plan = planGap(gap, standby);

    if (plan.problems.length > 0) refuse(plan.problems);

    await writePlan(client, plan, eventId);

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
