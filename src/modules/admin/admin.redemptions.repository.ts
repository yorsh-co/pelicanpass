import { env } from '../../config/env.ts';
import pg from '../../shared/db/postgres.ts';

import { PAGE_SIZE } from '../../constants/attendee-filters.ts';
import {
  escapeLike,
  fold,
  phoneQueryOf,
} from './admin.attendees.repository.ts';
import { decideCorrection } from './admin.redemptions.rules.ts';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error.ts';

import type {
  RedemptionCorrection,
  RedemptionCorrectionReason,
  RedemptionListFilters,
} from '../../constants/redemptions.ts';
import type {
  RedemptionItem,
  RedemptionOutcome,
} from '../../constants/pass.ts';
import type { AttendeeEntry } from '../../types/attendee.ts';
import type { SummaryRow } from './admin.redemptions.rules.ts';

/**
 * The administrator's view of redemptions: totals, the per-item list, the
 * corrections and one attendee's history.
 *
 * Current state is read from `attendees`, whose `*_option` and `*_redeemed_at`
 * columns the application already selects. History is read through
 * `redemption_history`, never from `redemptions` itself — `009` withholds
 * `SELECT` on the audit table, and migration 027 explains why the function is
 * the narrower door.
 *
 * Every statement is scoped to `env.eventId`, for the reason
 * `admin.attendees.repository.ts` gives.
 */

/**
 * Each item's column pair on `attendees`.
 *
 * The only source of column names interpolated below: a route parameter picks
 * a key after `isRedemptionItem` has checked it, and nothing typed by anybody
 * reaches the SQL text. `REDEEM_STATEMENTS` in `attendee.repository.ts` spells
 * its statements out in full instead; a correction needs three statements per
 * item and the list a fourth, and sixteen near-copies would hide the one
 * column that differs.
 */
export const ITEM_COLUMNS = {
  tshirt: { option: 'tshirt_size', redeemedAt: 'tshirt_redeemed_at' },
  meal: { option: 'meal_option', redeemedAt: 'meal_redeemed_at' },
  drink: { option: 'drink_option', redeemedAt: 'drink_redeemed_at' },
  lunch: { option: 'lunch_option', redeemedAt: 'lunch_redeemed_at' },
  tshirt_volunteer: {
    option: 'tshirt_volunteer_size',
    redeemedAt: 'tshirt_volunteer_redeemed_at',
  },
} as const satisfies Record<
  RedemptionItem,
  { option: keyof AttendeeEntry; redeemedAt: keyof AttendeeEntry }
>;

/** One row of the per-item list. */
export interface RedemptionListRow {
  attendee_id: string;
  ticket_code: string;
  attendee_name: string;
  attendee_nickname: string | null;
  attendee_role: AttendeeEntry['attendee_role'];
  checkin_complete: boolean;
  checkin_number: number | null;

  /** What they registered for: never null, the list only holds the entitled. */
  option: string;

  redeemed_at: Date | null;
}

/** One entry of an attendee's history, as `redemption_history` returns it. */
export interface RedemptionHistoryRow {
  item: RedemptionItem;

  /** A volunteer's outcome, or one of an administrator's two corrections. */
  outcome: RedemptionOutcome | 'marked' | 'reverted';

  actor_type: 'volunteer' | 'admin';

  /** `null` when the volunteer or administrator no longer exists. */
  actor_name: string | null;

  reason: RedemptionCorrectionReason | null;
  created_at: Date;
}

/**
 * Per-item totals, and the same counts per option.
 *
 * One pass over the roster: the lateral `VALUES` turns each attendee's four
 * column pairs into four rows, and the grouping sets count them once per item
 * and once per option. `GROUPING(i.option)` marks the item totals, which is
 * what tells them apart from an option row — `i.option` alone cannot, a total
 * carries `NULL` there.
 *
 * Archived attendees are left out, as they are from `checkinTotals`: an
 * archived record is not somebody expected at the counter.
 *
 * @returns One total row per item anybody is entitled to, and one row per
 *   option in use.
 */
export const redemptionSummary = async (): Promise<SummaryRow[]> => {
  const result = await pg.query<SummaryRow>(
    `SELECT i.item,
            i.option,
            GROUPING(i.option) = 1                        AS "isTotal",
            count(*)::int                                 AS expected,
            count(i.redeemed_at)::int                     AS redeemed,
            count(*) FILTER (
              WHERE i.redeemed_at IS NULL AND a.checkin_complete
            )::int                                        AS "pendingPresent",
            count(*) FILTER (
              WHERE i.redeemed_at IS NULL AND NOT a.checkin_complete
            )::int                                        AS "pendingAbsent"
     FROM attendees a
     CROSS JOIN LATERAL (VALUES
       ('tshirt', a.tshirt_size,  a.tshirt_redeemed_at),
       ('meal',   a.meal_option,  a.meal_redeemed_at),
       ('drink',  a.drink_option, a.drink_redeemed_at),
       ('lunch',  a.lunch_option, a.lunch_redeemed_at),
       ('tshirt_volunteer', a.tshirt_volunteer_size,
                            a.tshirt_volunteer_redeemed_at)
     ) AS i (item, option, redeemed_at)
     WHERE a.event_id = $1
       AND a.archived_at IS NULL
       AND i.option IS NOT NULL
     GROUP BY GROUPING SETS ((i.item), (i.item, i.option))`,
    [env.eventId],
  );

  return result.rows;
};

/**
 * One page of the attendees entitled to an item, and how many matched.
 *
 * Paged, counted and searched exactly as `listAttendees` is — the same
 * `count(*) OVER ()` and the same recount past the last page, for the reasons
 * given there, and the same search over name, nickname, ticket code and phone
 * digits.
 *
 * @param filters - Parsed filters from the submitted form.
 * @returns The page and the filtered total.
 */
export const listRedemptionRoster = async (
  filters: RedemptionListFilters,
): Promise<{ rows: RedemptionListRow[]; total: number }> => {
  const { item, status, checkedIn, q, page } = filters;
  const { option, redeemedAt } = ITEM_COLUMNS[item];

  const like = q ? `%${escapeLike(q)}%` : '';
  const phone = q ? phoneQueryOf(q) : '';

  const filter = `WHERE event_id = $1
    AND archived_at IS NULL
    AND ${option} IS NOT NULL
    AND ($2 = 'all' OR ($2 = 'redeemed') = (${redeemedAt} IS NOT NULL))
    AND ($3::boolean IS NULL OR checkin_complete = $3)
    AND ($4 = ''
      OR ticket_code = $4
      OR ${fold('attendee_name')} ILIKE ${fold('$5')}
      OR ${fold("coalesce(attendee_nickname, '')")} ILIKE ${fold('$5')}
      OR ($6 <> '' AND regexp_replace(attendee_phone, '\\D', '', 'g') LIKE $6))`;

  const filterParams = [env.eventId, status, checkedIn, q, like, phone];

  const result = await pg.query<RedemptionListRow & { total_rows: string }>(
    `SELECT attendee_id,
            ticket_code,
            attendee_name,
            attendee_nickname,
            attendee_role,
            checkin_complete,
            checkin_number,
            ${option}     AS option,
            ${redeemedAt} AS redeemed_at,
            count(*) OVER () AS total_rows
     FROM attendees
     ${filter}
     ORDER BY attendee_name, ticket_code
     LIMIT $7 OFFSET $8`,
    [...filterParams, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );

  const first = result.rows[0];

  if (first) {
    return {
      rows: result.rows,
      total: Number.parseInt(first.total_rows, 10),
    };
  }

  if (page === 1) return { rows: [], total: 0 };

  const counted = await pg.query<{ total_rows: string }>(
    `SELECT count(*) AS total_rows FROM attendees ${filter}`,
    filterParams,
  );

  return {
    rows: [],
    total: Number.parseInt(counted.rows[0]?.total_rows ?? '0', 10),
  };
};

/** What a correction leaves behind. */
export interface CorrectionResult {
  item: RedemptionItem;

  /** The new collection time after a mark; `null` after a revert. */
  redeemedAt: Date | null;
}

/** Everything {@link correctRedemption} needs to act and to audit. */
export interface CorrectionInput {
  attendeeId: string;
  item: RedemptionItem;
  correction: RedemptionCorrection;
  reason: RedemptionCorrectionReason;
  adminId: string;

  /** What the operator's screen showed, for a revert. */
  expectedRedeemedAt: Date | null;
}

/**
 * Applies an administrator's correction, and records it.
 *
 * The row is locked before anything is decided, so the decision and the write
 * see the same state: a volunteer's redemption landing between them waits for
 * this transaction, and then finds the item already collected — or, after a
 * revert, collects it again, which is the right answer either way.
 * `FOR UPDATE` needs `UPDATE` on one column of the table, which `009` and `026`
 * granted on the timestamps.
 *
 * The audit row goes in the same transaction as the change, so the two cannot
 * disagree. As in `redeemItem`, the insert cannot use `RETURNING`: the role
 * holds `INSERT` on `redemptions` and no `SELECT`.
 *
 * **Not every refusal is recorded**, unlike a volunteer's attempts. A refused
 * correction changed nothing on the attendee's record, and `redemptions`
 * records what happened to that record; the refusal is logged by the error
 * handler like any other.
 *
 * @param input - The correction, already validated.
 * @returns The item's new state.
 * @throws {NotFoundError} If no attendee has that ID under this event.
 * @throws {ConflictError} With the refusal from `decideCorrection`.
 */
export const correctRedemption = async (
  input: CorrectionInput,
): Promise<CorrectionResult> => {
  const { attendeeId, item, correction, reason, adminId } = input;
  const { option, redeemedAt } = ITEM_COLUMNS[item];

  const client = await pg.connect();

  try {
    await client.query('BEGIN');

    const locked = await client.query<{
      archived: boolean;
      entitlement: string | null;
      redeemed_at: Date | null;
    }>(
      `SELECT archived_at IS NOT NULL AS archived,
              ${option}               AS entitlement,
              ${redeemedAt}           AS redeemed_at
       FROM attendees
       WHERE attendee_id = $1
         AND event_id = $2
       FOR UPDATE`,
      [attendeeId, env.eventId],
    );

    const row = locked.rows[0];

    if (!row) {
      throw new NotFoundError('Attendee not found', {
        reason: 'attendeeNotFound',
      });
    }

    const decision = decideCorrection(
      {
        archived: row.archived,
        entitlement: row.entitlement,
        redeemedAt: row.redeemed_at,
      },
      correction,
      input.expectedRedeemedAt,
    );

    if (decision !== 'apply') {
      throw new ConflictError(`Cannot ${correction} ${item}`, {
        reason: decision,
        item,
      });
    }

    const updated = await client.query<{ redeemed_at: Date | null }>(
      `UPDATE attendees
       SET ${redeemedAt} = ${correction === 'mark' ? 'now()' : 'NULL'}
       WHERE attendee_id = $1
         AND event_id = $2
       RETURNING ${redeemedAt} AS redeemed_at`,
      [attendeeId, env.eventId],
    );

    await client.query(
      `INSERT INTO redemptions
         (event_id, attendee_id, item, outcome, redeemed_by, actor_type, reason)
       VALUES ($1, $2, $3, $4, $5, 'admin', $6)`,
      [
        env.eventId,
        attendeeId,
        item,
        correction === 'mark' ? 'marked' : 'reverted',
        adminId,
        reason,
      ],
    );

    await client.query('COMMIT');

    return { item, redeemedAt: updated.rows[0]?.redeemed_at ?? null };
  } catch (err) {
    await client.query('ROLLBACK');

    throw err;
  } finally {
    client.release();
  }
};

/**
 * One attendee's redemption history, newest first.
 *
 * @param attendeeId - Attendee to read.
 * @returns At most `REDEMPTION_HISTORY_LIMIT` entries.
 */
export const redemptionHistory = async (
  attendeeId: string,
): Promise<RedemptionHistoryRow[]> => {
  const result = await pg.query<RedemptionHistoryRow>(
    'SELECT * FROM redemption_history($1, $2)',
    [env.eventId, attendeeId],
  );

  return result.rows;
};
