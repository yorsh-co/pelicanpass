import { env } from '../../config/env.ts';
import pg from '../../shared/db/postgres.ts';

import type { PoolClient } from 'pg';
import type {
  RedemptionItem,
  RedemptionOutcome,
} from '../../constants/pass.ts';
import type { AttendeeEntry, AttendeeProfile } from '../../types/attendee.ts';
import { firstName } from '../../shared/utils/mask.ts';
import { accessTier } from './attendee.access-tier.ts';

/**
 * Columns {@link getAttendeeProfile} projects.
 *
 * `AttendeeEntry` describes a full row, so each query narrows it to what its
 * own `SELECT` actually returns rather than claiming columns it never read.
 */
type AttendeeProfileRow = Pick<
  AttendeeEntry,
  | 'ticket_code'
  | 'attendee_name'
  | 'attendee_nickname'
  | 'checkin_number'
  | 'checkin_at'
  | 'attendee_role'
  | 'can_redeem'
  | 'redeem_scopes'
  | 'can_draw'
  | 'show_admin_link'
  | 'team'
  | 'team_role'
  | 'meal_option'
  | 'meal_redeemed_at'
  | 'drink_option'
  | 'drink_redeemed_at'
  | 'tshirt_size'
  | 'tshirt_redeemed_at'
  | 'lunch_option'
  | 'lunch_redeemed_at'
  | 'tshirt_volunteer_size'
  | 'tshirt_volunteer_redeemed_at'
> & {
  survey_completed: boolean;

  /** From the linked administrator; null when none is linked and active. */
  admin_scopes: string[] | null;
};

/**
 * Columns {@link getAttendeeByTicket} and {@link getAttendeeByLinkToken}
 * project.
 *
 * `ticket_code` is included even though the ticket lookup already has it,
 * because the link lookup does not: the session stores the code and
 * {@link completeCheckin} keys on it, so it has to come back from the row.
 */
export type AttendeeTicketRow = Pick<
  AttendeeEntry,
  | 'attendee_id'
  | 'ticket_code'
  | 'attendee_phone'
  | 'attendee_name'
  | 'attendee_role'
  | 'checkin_complete'
  | 'checkin_at'
  | 'checkin_number'
>;

/**
 * Every statement here is scoped to `env.eventId`.
 *
 * It is a deployment constant rather than a per-call argument: one stack serves
 * one event, so threading it through every caller would add an argument that
 * can only ever hold one value. Filtering on it means a row belonging to
 * another event is invisible to this application even though `ticket_code` is
 * unique table-wide.
 *
 * **Every statement here also excludes archived attendees**, added by migration
 * 015. That is what makes archiving a real disable rather than a filter on one
 * administrator's table: an archived attendee cannot check in, open their pass,
 * be served at a counter or be drawn. The clause has to be on each statement
 * individually — there is no view or row policy doing it centrally — so a new
 * reader added to this file needs it too.
 *
 * {@link redeemItem} is the one deliberate exception; see its own note.
 */

/** Columns every {@link AttendeeTicketRow} query selects. */
const TICKET_ROW_COLUMNS = `
  attendee_id,
  ticket_code,
  attendee_phone,
  attendee_name,
  attendee_role,
  checkin_complete,
  checkin_at,
  checkin_number`;

/** Columns the row lock in {@link completeCheckin} projects. */
type CheckinLockRow = Pick<
  AttendeeEntry,
  | 'ticket_code'
  | 'attendee_role'
  | 'checkin_complete'
  | 'checkin_at'
  | 'checkin_number'
>;

/**
 * Loads an attendee's own view of their record.
 *
 * The access tier is derived here from the volunteer's flags and the scopes of
 * the active administrator their `admin_username` names. The scopes themselves
 * stay in this function. The admin link shows when the flag is set or a
 * volunteer is linked to an active administrator.
 *
 * @param attendeeId - Attendee to load.
 * @returns The profile, or `null` if no attendee has that ID under this event,
 *   or they are archived.
 */
export const getAttendeeProfile = async (
  attendeeId: string,
): Promise<AttendeeProfile | null> => {
  const result = await pg.query<AttendeeProfileRow>(
    `SELECT
      ticket_code,
      attendee_name,
      attendee_nickname,
      checkin_number,
      checkin_at,
      attendee_role,
      can_redeem,
      redeem_scopes,
      can_draw,
      show_admin_link,
      team,
      team_role,
      meal_option,
      meal_redeemed_at,
      drink_option,
      drink_redeemed_at,
      tshirt_size,
      tshirt_redeemed_at,
      lunch_option,
      lunch_redeemed_at,
      tshirt_volunteer_size,
      tshirt_volunteer_redeemed_at,
      EXISTS (
        SELECT 1
        FROM survey_completions c
        WHERE c.event_id = $2
          AND c.attendee_id = $1
      ) AS survey_completed,
      ad.admin_scopes
    FROM attendees
    LEFT JOIN admins ad
      ON ad.username = attendees.admin_username
      AND ad.is_active
    WHERE attendees.attendee_id = $1
      AND attendees.event_id = $2
      AND attendees.archived_at IS NULL`,
    [attendeeId, env.eventId],
  );

  const entry = result.rows[0];
  if (!entry) return null;

  return {
    ticketCode: entry.ticket_code,
    attendeeFirstName: firstName(entry.attendee_name),
    attendeeNickname: entry.attendee_nickname,
    checkinNumber: entry.checkin_number,
    checkinAt: entry.checkin_at,
    attendeeRole: entry.attendee_role,
    canRedeem: entry.can_redeem,
    canDraw: entry.can_draw,
    showAdminLink:
      entry.show_admin_link ||
      (entry.attendee_role === 'volunteer' && entry.admin_scopes !== null),
    accessTier: accessTier({
      attendeeRole: entry.attendee_role,
      canRedeem: entry.can_redeem,
      redeemScopes: entry.redeem_scopes,
      canDraw: entry.can_draw,
      adminScopes: entry.admin_scopes,
    }),
    team: entry.team,
    teamRole: entry.team_role,

    mealOption: entry.meal_option,
    mealRedeemedAt: entry.meal_redeemed_at,
    drinkOption: entry.drink_option,
    drinkRedeemedAt: entry.drink_redeemed_at,
    tshirtSize: entry.tshirt_size,
    tshirtRedeemedAt: entry.tshirt_redeemed_at,
    lunchOption: entry.lunch_option,
    lunchRedeemedAt: entry.lunch_redeemed_at,
    tshirtVolunteerSize: entry.tshirt_volunteer_size,
    tshirtVolunteerRedeemedAt: entry.tshirt_volunteer_redeemed_at,

    surveyCompleted: entry.survey_completed,
  };
};

/**
 * Reads the role an attendee answers the questionnaire under, inside the
 * submit's transaction.
 *
 * The role comes from the row rather than the session: an administrator can
 * archive an attendee or change their role after check-in, and neither touches
 * a live session. Only a checked-in, unarchived attendee may answer.
 *
 * @param client - The submit's transaction.
 * @param attendeeId - Attendee from the session.
 * @returns Their role, or `null` if they may not answer.
 */
export const readAnsweringRole = async (
  client: PoolClient,
  attendeeId: string,
): Promise<AttendeeEntry['attendee_role'] | null> => {
  const { rows } = await client.query<Pick<AttendeeEntry, 'attendee_role'>>(
    `SELECT attendee_role
    FROM attendees
    WHERE attendee_id = $1
      AND event_id = $2
      AND archived_at IS NULL
      AND checkin_complete`,
    [attendeeId, env.eventId],
  );

  return rows[0]?.attendee_role ?? null;
};

/**
 * Sets or clears the display name an attendee chose for their pass.
 *
 * The value is written exactly as given — normalisation and validation belong
 * to the service, so this cannot be called with something the policy would have
 * rejected. `updated_at` is left to the `attendees_set_updated_at` trigger.
 *
 * @param attendeeId - Attendee to update.
 * @param nickname - Normalised value to store, or `null` to clear it.
 * @returns The stored value, or `null` if no attendee has that ID under this
 *   event, or they are archived.
 */
export const updateAttendeeNickname = async (
  attendeeId: string,
  nickname: string | null,
): Promise<{ nickname: string | null } | null> => {
  const result = await pg.query<Pick<AttendeeEntry, 'attendee_nickname'>>(
    `UPDATE attendees
      SET attendee_nickname = $1
    WHERE attendee_id = $2
      AND event_id = $3
      AND archived_at IS NULL
    RETURNING attendee_nickname`,
    [nickname, attendeeId, env.eventId],
  );

  const entry = result.rows[0];
  if (!entry) return null;

  return { nickname: entry.attendee_nickname };
};

/**
 * Looks up an attendee by ticket code, including their check-in status so the
 * flow can recognise a returning attendee.
 *
 * @param ticketCode - Ticket code to look up.
 * @returns The projected row, or `null` if no active attendee holds that
 *   ticket.
 */
export const getAttendeeByTicket = async (
  ticketCode: string,
): Promise<AttendeeTicketRow | null> => {
  const result = await pg.query<AttendeeTicketRow>(
    `SELECT ${TICKET_ROW_COLUMNS}
    FROM attendees
    WHERE ticket_code = $1
      AND event_id = $2
      AND archived_at IS NULL`,
    [ticketCode, env.eventId],
  );

  return result.rows[0] ?? null;
};

/**
 * Looks up an attendee by the opaque token their entry link carries.
 *
 * The token is a separate credential from the ticket code: it is what a printed
 * QR encodes, so a leaked link cannot be typed in at the manual entry step.
 *
 * @param linkToken - Token from the entry link's `t` parameter.
 * @returns The projected row, or `null` if no active attendee holds that
 *   token.
 */
export const getAttendeeByLinkToken = async (
  linkToken: string,
): Promise<AttendeeTicketRow | null> => {
  const result = await pg.query<AttendeeTicketRow>(
    `SELECT ${TICKET_ROW_COLUMNS}
    FROM attendees
    WHERE ticket_link_token = $1
      AND event_id = $2
      AND archived_at IS NULL`,
    [linkToken, env.eventId],
  );

  return result.rows[0] ?? null;
};

/**
 * Atomically marks an attendee as checked in and assigns a unique sequential
 * check-in number from a Postgres sequence.
 *
 * Re-running this for an attendee who has already checked in returns their
 * original number rather than issuing a second one, so a retried request
 * cannot consume two sequence values.
 *
 * Returns `null` when the locked row is not there — no attendee holds that
 * ticket under this event, or they have been archived since the flow began.
 * `null` rather than a throw because that is what every other reader in this
 * file already answers with, and because the caller has to turn it into a
 * refusal the check-in surface already knows how to render. A bare `Error`
 * here reached `errorHandler` as a 500.
 *
 * @param ticketCode - Ticket code being checked in.
 * @returns The attendee's check-in number (null for volunteers) and timestamp,
 *   or `null` if there is no active attendee holding that ticket.
 * @throws {Error} If the check-in number sequence cannot be read. That one is
 *   an infrastructure fault and stays a 500.
 */
export const completeCheckin = async (
  ticketCode: string,
): Promise<{ checkinNumber: number | null; checkinAt: Date } | null> => {
  const client = await pg.connect();

  try {
    await client.query('BEGIN');

    // lock the row
    const { rows } = await client.query<CheckinLockRow>(
      `SELECT
        ticket_code,
        attendee_role,
        checkin_complete,
        checkin_at,
        checkin_number
      FROM attendees
      WHERE ticket_code = $1
        AND event_id = $2
        AND archived_at IS NULL
      FOR UPDATE`,
      [ticketCode, env.eventId],
    );

    const existing = rows[0];

    // Nothing has been written, so the transaction is rolled back rather than
    // committed: no row matched, and saying so is cheaper than pretending a
    // unit of work happened.
    if (!existing) {
      await client.query('ROLLBACK');

      return null;
    }

    if (
      existing.checkin_complete &&
      (existing.attendee_role !== 'participant' || existing.checkin_number) &&
      existing.checkin_at
    ) {
      await client.query('COMMIT');

      return {
        checkinNumber: existing.checkin_number,
        checkinAt: existing.checkin_at,
      };
    }

    // generate unique and sequential checkin_number for participants
    let checkinNumber: number | null = null;
    if (existing.attendee_role === 'participant') {
      const sequenceResult = await client.query<{ num: string }>(
        `SELECT nextval('checkin_number_seq') AS num`,
      );

      const sequenceRow = sequenceResult.rows[0];

      if (!sequenceRow) throw new Error('Failed to reserve a checkin number');

      checkinNumber = parseInt(sequenceRow.num, 10);
    }

    const checkinAt = new Date();

    await client.query(
      `UPDATE attendees
      SET checkin_complete = TRUE,
        checkin_at = $1,
        checkin_number = $2,
        updated_at = NOW()
      WHERE ticket_code = $3
        AND event_id = $4`,
      [checkinAt, checkinNumber, ticketCode, env.eventId],
    );

    await client.query('COMMIT');

    return { checkinNumber, checkinAt };
  } catch (err) {
    await client.query('ROLLBACK');

    throw err;
  } finally {
    client.release();
  }
};

/** Columns {@link getRedeemPermission} projects. */
type RedeemPermissionRow = Pick<
  AttendeeEntry,
  'attendee_role' | 'can_redeem' | 'redeem_scopes'
>;

/**
 * Reads whether an attendee may record a redemption.
 *
 * Read on every request against the staff surface rather than baked into the
 * session, so revoking a volunteer takes effect on their next action instead of
 * waiting out the 24-hour attendee TTL.
 *
 * The scopes ride along on the same row rather than a second query: the read is
 * already happening on every staff request, so narrowing a volunteer to one
 * station inherits the property that justifies it — they move stations on their
 * next tap, not at their next login.
 *
 * @param attendeeId - Attendee to check.
 * @returns Their role, permission and scopes, or `null` if no attendee has that
 *   ID, or they are archived.
 */
export const getRedeemPermission = async (
  attendeeId: string,
): Promise<RedeemPermissionRow | null> => {
  const result = await pg.query<RedeemPermissionRow>(
    `SELECT
      attendee_role,
      can_redeem,
      redeem_scopes
    FROM attendees
    WHERE attendee_id = $1
      AND event_id = $2
      AND archived_at IS NULL`,
    [attendeeId, env.eventId],
  );

  return result.rows[0] ?? null;
};

/** Columns {@link getDrawPermission} projects. */
type DrawPermissionRow = Pick<AttendeeEntry, 'attendee_role' | 'can_draw'>;

/**
 * Reads whether an attendee may run the raffle draw.
 *
 * Its own reader rather than a widening of {@link getRedeemPermission}: the two
 * surfaces are reached by different people and gated independently, and a
 * request against one has no business carrying the other's answer. The cost is
 * a near-identical statement; the benefit is that neither gate can be widened
 * by a change made for the other.
 *
 * Read per request for the same reason as the redeem permission — standing a
 * draw operator down takes effect on their next tap, not when their session
 * expires.
 *
 * @param attendeeId - Attendee to check.
 * @returns Their role and permission, or `null` if no attendee has that ID, or
 *   they are archived.
 */
export const getDrawPermission = async (
  attendeeId: string,
): Promise<DrawPermissionRow | null> => {
  const result = await pg.query<DrawPermissionRow>(
    `SELECT
      attendee_role,
      can_draw
    FROM attendees
    WHERE attendee_id = $1
      AND event_id = $2
      AND archived_at IS NULL`,
    [attendeeId, env.eventId],
  );

  return result.rows[0] ?? null;
};

/**
 * The column {@link listRaffleNumbers} projects.
 *
 * Declared non-null rather than narrowed from `AttendeeEntry`: that type
 * describes the table, where the column is nullable, and this query's own
 * `WHERE` clause excludes the nulls. Asserting the difference at the call site
 * would put the guarantee somewhere other than the statement that provides it.
 */
interface RaffleNumberRow {
  checkin_number: number;
}

/**
 * Every check-in number eligible for the raffle.
 *
 * Filtering on a non-null number is what excludes volunteers, without naming
 * the role: they have carried no number since `97ce844`, precisely so they are
 * not in the draw. `checkin_complete` is belt and braces — the number is
 * assigned by {@link completeCheckin} and by nothing else — but the conditions
 * say what the pool *is* rather than how it happens to be populated.
 *
 * `archived_at IS NULL` is a fourth, and it is not belt and braces: an attendee
 * retired after they checked in keeps their number, and drawing it would call a
 * number across a room for somebody the event has taken off its roster.
 *
 * Returns the whole pool rather than picking a winner in SQL. `ORDER BY
 * random() LIMIT 1` would be one round trip, but the selection would then live
 * in a statement rather than in code, and a draw is the one thing in this
 * application somebody may eventually ask to have explained. A few hundred
 * integers is nothing to carry.
 *
 * @returns Eligible numbers, ascending.
 */
export const listRaffleNumbers = async (): Promise<number[]> => {
  const result = await pg.query<RaffleNumberRow>(
    `SELECT checkin_number
    FROM attendees
    WHERE event_id = $1
      AND archived_at IS NULL
      AND checkin_complete
      AND checkin_number IS NOT NULL
    ORDER BY checkin_number`,
    [env.eventId],
  );

  return result.rows.map((row) => row.checkin_number);
};

/**
 * The conditional update for each redeemable item.
 *
 * One complete statement per item rather than an interpolated column name.
 * Identifiers cannot be bound as parameters, so the only safe way to vary a
 * column is to have already written every version of the statement — the
 * `switch` in {@link redeemItem} picks between these and nothing reaches SQL
 * that did not start life in this file.
 *
 * Each is conditional twice over: `IS NULL` on the timestamp is what makes a
 * second attempt affect no rows, and `IS NOT NULL` on the entitlement is what
 * stops an item nobody registered for being handed out. Zero rows is therefore
 * ambiguous by design, and the caller resolves it.
 *
 * Each aliases its `RETURNING` to `redeemed_at` so every item yields the same row
 * shape — the item varies but the type does not.
 */
const REDEEM_STATEMENTS = {
  tshirt: `UPDATE attendees SET tshirt_redeemed_at = now()
    WHERE attendee_id = $1
      AND event_id = $2
      AND tshirt_size IS NOT NULL
      AND tshirt_redeemed_at IS NULL
    RETURNING tshirt_redeemed_at AS redeemed_at`,

  meal: `UPDATE attendees SET meal_redeemed_at = now()
    WHERE attendee_id = $1
      AND event_id = $2
      AND meal_option IS NOT NULL
      AND meal_redeemed_at IS NULL
    RETURNING meal_redeemed_at AS redeemed_at`,

  drink: `UPDATE attendees SET drink_redeemed_at = now()
    WHERE attendee_id = $1
      AND event_id = $2
      AND drink_option IS NOT NULL
      AND drink_redeemed_at IS NULL
    RETURNING drink_redeemed_at AS redeemed_at`,

  lunch: `UPDATE attendees SET lunch_redeemed_at = now()
    WHERE attendee_id = $1
      AND event_id = $2
      AND lunch_option IS NOT NULL
      AND lunch_redeemed_at IS NULL
    RETURNING lunch_redeemed_at AS redeemed_at`,

  tshirt_volunteer: `UPDATE attendees SET tshirt_volunteer_redeemed_at = now()
    WHERE attendee_id = $1
      AND event_id = $2
      AND tshirt_volunteer_size IS NOT NULL
      AND tshirt_volunteer_redeemed_at IS NULL
    RETURNING tshirt_volunteer_redeemed_at AS redeemed_at`,
} as const;

/** The follow-up that tells `duplicate` from `not_entitled`. */
const REDEEM_STATE_STATEMENTS = {
  tshirt: `SELECT tshirt_size AS entitlement, tshirt_redeemed_at AS redeemed_at
    FROM attendees WHERE attendee_id = $1 AND event_id = $2`,

  meal: `SELECT meal_option AS entitlement, meal_redeemed_at AS redeemed_at
    FROM attendees WHERE attendee_id = $1 AND event_id = $2`,

  drink: `SELECT drink_option AS entitlement, drink_redeemed_at AS redeemed_at
    FROM attendees WHERE attendee_id = $1 AND event_id = $2`,

  lunch: `SELECT lunch_option AS entitlement, lunch_redeemed_at AS redeemed_at
    FROM attendees WHERE attendee_id = $1 AND event_id = $2`,

  tshirt_volunteer: `SELECT tshirt_volunteer_size AS entitlement,
      tshirt_volunteer_redeemed_at AS redeemed_at
    FROM attendees WHERE attendee_id = $1 AND event_id = $2`,
} as const;

/**
 * Hands one item to one attendee, once, and records that it happened.
 *
 * The conditional `UPDATE` is the control, not the audit table and not any
 * uniqueness constraint: a second attempt matches no rows because the timestamp
 * is already set, which is atomic without needing to read first and decide
 * after.
 *
 * **Every outcome is recorded, not only the successes.** A refusal is the more
 * interesting row — a cluster of `duplicate` against one attendee is what a
 * circulating screenshot looks like from the server side, and it is the reason
 * this table exists at all.
 *
 * The audit insert names exactly the columns migrations 009 and 027 grant, and
 * it cannot use `RETURNING`: the application holds `INSERT` on `redemptions`
 * and no `SELECT`, and `RETURNING` needs read privilege on what it returns.
 * That is the append-only guarantee showing up as a constraint on the writer.
 *
 * **The statements below are deliberately not filtered on `archived_at`, unlike
 * every other reader in this file.** Do not "finish the job": this is only
 * reachable through a review handle, and `StaffService.#openReview` goes through
 * {@link getAttendeeProfile}, which already refuses an archived attendee. The
 * only way in is a handle minted in the 120 seconds before the archive — and
 * adding the clause would push that case into the `not_entitled` branch, which
 * tells a volunteer at a counter that the attendee never registered for the
 * item. A 120-second window is the same one every other permission withdrawal
 * in this system has.
 *
 * @param attendeeId - Who is collecting.
 * @param item - What they are collecting.
 * @param redeemedBy - Who is recording it: the volunteer's own attendee ID,
 *   never a check-in number, or an administrator's ID when `actorType` is
 *   `admin`.
 * @param actorType - Which table `redeemedBy` names. Defaults to `volunteer`,
 *   which is what `/staff` records; the admin T-shirt desk passes `admin`.
 *   Corrections are written elsewhere, so this never carries a reason.
 * @returns What happened, and the timestamp if something did.
 */
export const redeemItem = async (
  attendeeId: string,
  item: RedemptionItem,
  redeemedBy: string,
  actorType: 'volunteer' | 'admin' = 'volunteer',
): Promise<{ outcome: RedemptionOutcome; redeemedAt: Date | null }> => {
  const client = await pg.connect();

  try {
    await client.query('BEGIN');

    const updated = await client.query<{ redeemed_at: Date }>(
      REDEEM_STATEMENTS[item],
      [attendeeId, env.eventId],
    );

    let outcome: RedemptionOutcome;
    let redeemedAt: Date | null = null;

    const written = updated.rows[0];

    if (written) {
      outcome = 'redeemed';
      redeemedAt = written.redeemed_at;
    } else {
      // Zero rows means one of two different things, and the volunteer needs to
      // be told which: "they already have it" and "they never had one" call for
      // different conversations at the counter.
      const state = await client.query<{
        entitlement: string | null;
        redeemed_at: Date | null;
      }>(REDEEM_STATE_STATEMENTS[item], [attendeeId, env.eventId]);

      const row = state.rows[0];

      outcome = row?.redeemed_at ? 'duplicate' : 'not_entitled';
      redeemedAt = row?.redeemed_at ?? null;
    }

    await client.query(
      `INSERT INTO redemptions
        (event_id, attendee_id, item, outcome, redeemed_by, actor_type)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [env.eventId, attendeeId, item, outcome, redeemedBy, actorType],
    );

    await client.query('COMMIT');

    return { outcome, redeemedAt };
  } catch (err) {
    await client.query('ROLLBACK');

    throw err;
  } finally {
    client.release();
  }
};
