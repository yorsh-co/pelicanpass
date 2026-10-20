import { env } from '../../config/env.ts';
import { WALK_IN_TICKET_PREFIX } from '../../constants/ticket.ts';
import pg from '../../shared/db/postgres.ts';

/**
 * Postgres reads for the metrics panel, and nothing else.
 *
 * Redis is the other half and lives in `shared/telemetry/counters.ts`. The
 * split follows what each store is for: Redis holds the minute-resolution
 * counters that expire within the hour, Postgres holds what `017` made durable.
 */

/** One error signature, as the panel groups them. */
export interface TopError {
  fingerprint: string;
  code: string | null;
  route: string | null;
  message: string;
  occurrences: number;
  lastSeen: Date;
}

/** Redemptions per item and outcome, from the migrator-owned view. */
export interface RedemptionTotal {
  item: string;
  outcome: string;
  total: number;
}

/**
 * The loudest error signatures in the recent past.
 *
 * Grouped by `fingerprint` rather than by message, which is what makes one bug
 * one row: the same failure from two requests differs in its message detail and
 * agrees on its fingerprint.
 *
 * @param minutes - How far back to look.
 * @param limit - Most signatures to return.
 * @returns Signatures, loudest first.
 */
export const topErrors = async (
  minutes = 15,
  limit = 10,
): Promise<TopError[]> => {
  const result = await pg.query<TopError>(
    `SELECT fingerprint,
            max(code)          AS code,
            max(route)         AS route,
            max(message)       AS message,
            count(*)::int      AS occurrences,
            max(occurred_at)   AS "lastSeen"
     FROM app_events
     WHERE event_id = $1
       AND severity IN ('error', 'fatal')
       AND occurred_at > now() - make_interval(mins => $2::int)
     GROUP BY fingerprint
     ORDER BY count(*) DESC
     LIMIT $3`,
    [env.eventId, minutes, limit],
  );

  return result.rows;
};

/**
 * Redemption totals per item and outcome.
 *
 * Reads `redemption_metrics`, not `redemptions`. `009` withholds `SELECT` on
 * the audit table from the application role deliberately, and `017` added a
 * migrator-owned view so the panel can count without that grant being widened.
 * A query here against the base table is refused, which is the intended shape
 * rather than an obstacle.
 *
 * @param minutes - How far back to look.
 * @returns One row per item and outcome seen in the window.
 */
export const redemptionTotals = async (
  minutes = 60,
): Promise<RedemptionTotal[]> => {
  const result = await pg.query<RedemptionTotal>(
    `SELECT item, outcome, sum(n)::int AS total
     FROM redemption_metrics
     WHERE event_id = $1
       AND bucket > now() - make_interval(mins => $2::int)
     GROUP BY item, outcome
     ORDER BY item, outcome`,
    [env.eventId, minutes],
  );

  return result.rows;
};

/**
 * How many attendees have completed check-in, against the roster.
 *
 * @returns Checked-in and expected counts, split by role.
 */
export const checkinTotals = async (): Promise<
  { attendeeRole: string; checkedIn: number; expected: number }[]
> => {
  const result = await pg.query<{
    attendeeRole: string;
    checkedIn: number;
    expected: number;
  }>(
    `SELECT attendee_role                                   AS "attendeeRole",
            count(*) FILTER (WHERE checkin_complete)::int   AS "checkedIn",
            count(*)::int                                   AS expected
     FROM attendees
     WHERE event_id = $1
       AND archived_at IS NULL
     GROUP BY attendee_role
     ORDER BY attendee_role`,
    [env.eventId],
  );

  return result.rows;
};

/** Participant check-in counts for one ticket prefix. */
export interface CheckinPrefixTotal {
  /** The code's one-character key, such as `x`, `7` or `d`. */
  prefix: string;
  checkedIn: number;
  expected: number;
}

/**
 * Participant check-ins broken down by ticket-code prefix.
 *
 * Participants only. A `v` code is always a volunteer, so the prefix would
 * repeat what the role split in {@link checkinTotals} already shows.
 *
 * The prefix is the code's first character. Ordering lives here and
 * nowhere else: the walk-in prefix first, then the other prefixes
 * alphabetically. The set is open-ended, so there is no list of known prefixes
 * to sort by.
 *
 * @returns One row per prefix present among the event's participants.
 */
export const checkinTotalsByPrefix = async (): Promise<
  CheckinPrefixTotal[]
> => {
  const result = await pg.query<CheckinPrefixTotal>(
    `SELECT prefix,
            count(*) FILTER (WHERE checkin_complete)::int   AS "checkedIn",
            count(*)::int                                   AS expected
     FROM (
       SELECT left(ticket_code, 1) AS prefix, checkin_complete
       FROM attendees
       WHERE event_id = $1
         AND archived_at IS NULL
         AND attendee_role = 'participant'
     ) AS participants
     GROUP BY prefix
     ORDER BY prefix <> $2, prefix`,
    [env.eventId, WALK_IN_TICKET_PREFIX],
  );

  return result.rows;
};
