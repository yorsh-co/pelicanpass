import { env } from '../../config/env.ts';
import pg from '../../shared/db/postgres.ts';

import { PAGE_SIZE } from '../../constants/attendee-filters.ts';

import type { AttendeeListFilters } from '../../constants/attendee-filters.ts';
import type { Queryable } from './admin.whatsapp.repository.ts';
import type { AttendeeEntry } from '../../types/attendee.ts';

/**
 * The administrator's view of the attendee roster.
 *
 * Its own file rather than an extension of `attendee.repository.ts`. That one
 * is the attendee-facing projection set — every public read path imports it,
 * and every statement in it excludes archived rows — so dropping an admin
 * `INSERT` and an archive-inclusive read into the middle of it would make both
 * the grant story and the archive rule harder to follow. The two files touch
 * one table; `migrations/016_attendee-editor-grants.ts` is the contract between
 * them.
 *
 * Every statement here is scoped to `env.eventId`, for the reason
 * `attendee.repository.ts` gives: one stack serves one event, so threading it
 * through every caller would add an argument that can only hold one value.
 *
 * Nothing here validates. The service owns the rules and this writes what it is
 * given, which is the arrangement `updateAttendeeNickname` already describes.
 */

/**
 * Columns the roster projects.
 *
 * A `Pick` of the full row rather than a fresh interface, per the convention
 * that a query narrows `AttendeeEntry` rather than claiming columns it never
 * read. Every one is granted `SELECT` — the application role holds all but
 * `created_at` and `updated_at`, which `005` withholds on purpose.
 *
 * `can_redeem`, `redeem_scopes` and `can_draw` are read and never written: the
 * editor shows what a volunteer is permitted to do and cannot change it, since
 * `008`, `010` and `011` grant `SELECT` on them and deliberately not `UPDATE`.
 */
export type AttendeeAdminRow = Pick<
  AttendeeEntry,
  | 'attendee_id'
  | 'ticket_code'
  | 'attendee_name'
  | 'attendee_nickname'
  | 'attendee_phone'
  | 'attendee_role'
  | 'can_redeem'
  | 'redeem_scopes'
  | 'can_draw'
  | 'checkin_complete'
  | 'checkin_at'
  | 'checkin_number'
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
  | 'archived_at'
>;

/** Fields {@link createAttendee} writes. */
export interface AttendeeCreateInput {
  ticketCode: string;
  attendeeName: string;
  attendeePhone: string;
  attendeeRole: AttendeeEntry['attendee_role'];
  mealOption: string | null;
  drinkOption: string | null;
  tshirtSize: string | null;
  lunchOption: string | null;
  tshirtVolunteerSize: string | null;
}

/** Fields {@link updateAttendee} writes. Every one is replaced, not merged. */
export type AttendeeUpdateInput = Omit<AttendeeCreateInput, 'ticketCode'>;

/** Columns every roster query selects. */
const ADMIN_ROW_COLUMNS = `
  attendee_id,
  ticket_code,
  attendee_name,
  attendee_nickname,
  attendee_phone,
  attendee_role,
  can_redeem,
  redeem_scopes,
  can_draw,
  checkin_complete,
  checkin_at,
  checkin_number,
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
  archived_at`;

/**
 * The accented characters search folds away, and what it folds them to.
 *
 * `ILIKE` is case-insensitive and **not** accent-insensitive — `'José' ILIKE
 * '%jose%'` is false — and this is a pt-BR roster where the first name in it is
 * likely to carry a diacritic. Somebody typing `joao` at a desk has to find
 * `João`.
 *
 * `translate()` rather than the `unaccent` extension, which is available on the
 * image but not installed. Installing it means `CREATE EXTENSION`, which needs
 * `CREATE` on the database — a privilege the migrator deliberately lacks, and
 * why `pgcrypto` lives in `scripts/db/init/01-roles.sh` rather than in a
 * migration. That would buy a step on the production host in exchange for
 * nothing this does not already do at a few hundred rows, where the sequential
 * scan costs nothing and no index could use a non-`IMMUTABLE` function anyway.
 *
 * Applied to **both sides** of the comparison, so the column and the query are
 * folded by one rule that cannot drift. Neither string contains `%` or `_`, so
 * folding leaves the escaped wildcards below untouched.
 */
// eslint-disable-next-line no-restricted-syntax -- a folding table for search, never shown
const ACCENTED = 'áàâãäçéèêëíìîïñóòôõöúùûüýÁÀÂÃÄÇÉÈÊËÍÌÎÏÑÓÒÔÕÖÚÙÛÜÝ';
const UNACCENTED = 'aaaaaceeeeiiiinooooouuuuyAAAAACEEEEIIIINOOOOOUUUUY';

/** Folds one expression for comparison. */
export const fold = (expr: string): string =>
  `translate(${expr}, '${ACCENTED}', '${UNACCENTED}')`;

/**
 * Escapes the wildcards `LIKE` would otherwise honour in a typed search.
 *
 * Without this a search for `100%` matches every row, and one for `_` matches
 * every row with at least one character. The backslash goes first, or it would
 * escape the escapes added after it.
 *
 * @param value - Raw search text.
 */
export const escapeLike = (value: string): string =>
  value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Strips everything but digits, for comparing a typed phone to a stored one. */
const digitsOf = (value: string): string => value.replace(/\D/g, '');

/**
 * Fewest digits that count as searching for a phone number.
 *
 * Four, because that is the length of the verification code an operator reads
 * off a record and the shortest fragment anybody would search by on purpose.
 */
const MIN_PHONE_DIGITS = 4;

/** A typed value that is a phone fragment rather than a name or a code. */
const PHONE_QUERY_RE = /^[\d\s()+.-]+$/;

/**
 * The phone fragment to search for, or `''` to skip that branch entirely.
 *
 * Two guards, and both were earned by measuring. The search box is one field
 * over four columns, so without them a query aimed at one column drags in
 * matches from another: `t3st` strips to the single digit `3` and `LIKE '%3%'`
 * then matches most of the roster's phone numbers, which is how a ticket-code
 * search ends up returning strangers.
 *
 * Requiring the whole query to look like a number is what separates intent from
 * coincidence — a value carrying letters is a name or a code, whatever digits
 * happen to sit inside it. The length floor then keeps `55` from matching every
 * number in the state.
 *
 * @param value - Normalised search text.
 */
export const phoneQueryOf = (value: string): string => {
  if (!PHONE_QUERY_RE.test(value)) return '';

  const digits = digitsOf(value);

  return digits.length >= MIN_PHONE_DIGITS ? `%${digits}%` : '';
};

/**
 * The filter clause, shared by the page query and the count that backs it up.
 *
 * One string rather than two copies: the two statements must agree about what
 * "matching" means, and a filter edited in one place and not the other is the
 * kind of drift that shows up as a wrong total long after the change.
 *
 * Parameters `$1`–`$7`, in the order {@link listAttendees} binds them.
 */
const ROSTER_FILTER = `WHERE event_id = $1
  AND ($2 = 'all'
    OR ($2 = 'only') = (archived_at IS NOT NULL))
  AND ($3::text IS NULL OR attendee_role = $3)
  AND ($4::boolean IS NULL OR checkin_complete = $4)
  AND ($5 = ''
    OR ticket_code = $5
    OR ${fold('attendee_name')} ILIKE ${fold('$6')}
    OR ${fold("coalesce(attendee_nickname, '')")} ILIKE ${fold('$6')}
    OR ($7 <> '' AND regexp_replace(attendee_phone, '\\D', '', 'g') LIKE $7))`;

/**
 * One page of the roster, and how many rows the filters matched in total.
 *
 * The count rides along as `count(*) OVER ()` rather than being a second query:
 * the window runs before `LIMIT`, so it reports the filtered total while the
 * rows are already the page. A separate `COUNT` would be a round trip for a
 * number this statement already has.
 *
 * Ordering is `attendee_name` then `ticket_code`. The tiebreak is not
 * decoration — `OFFSET` pagination repeats or skips rows when the sort is not
 * total, and two people sharing a name is the ordinary case, not the edge one.
 *
 * @param filters - Parsed filters from the submitted form.
 * @returns The page and the filtered total.
 */
export const listAttendees = async (
  filters: AttendeeListFilters,
): Promise<{ rows: AttendeeAdminRow[]; total: number }> => {
  const { q, role, checkedIn, archived, page } = filters;

  const like = q ? `%${escapeLike(q)}%` : '';
  const phone = q ? phoneQueryOf(q) : '';

  const filterParams = [env.eventId, archived, role, checkedIn, q, like, phone];

  const result = await pg.query<AttendeeAdminRow & { total_rows: string }>(
    `SELECT ${ADMIN_ROW_COLUMNS},
      count(*) OVER () AS total_rows
    FROM attendees
    ${ROSTER_FILTER}
    ORDER BY attendee_name, ticket_code
    LIMIT $8 OFFSET $9`,
    [...filterParams, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );

  const first = result.rows[0];

  if (first) {
    return {
      rows: result.rows,
      total: Number.parseInt(first.total_rows, 10),
    };
  }

  // `count(*) OVER ()` needs a row to ride on, so an OFFSET past the end
  // reports no total at all rather than reporting the real one. Left alone,
  // this function would answer "0 matches" for a filter that matched hundreds,
  // and the caller could not tell that apart from a search that genuinely found
  // nothing. Only page one can be trusted to answer for itself.
  //
  // The second statement is skipped on page one, where an empty result really
  // does mean zero, so the ordinary path stays a single round trip.
  if (page === 1) return { rows: [], total: 0 };

  const counted = await pg.query<{ total_rows: string }>(
    `SELECT count(*) AS total_rows FROM attendees ${ROSTER_FILTER}`,
    filterParams,
  );

  return {
    rows: [],
    total: Number.parseInt(counted.rows[0]?.total_rows ?? '0', 10),
  };
};

/**
 * One attendee, for the edit form.
 *
 * **Deliberately does not exclude archived rows**, unlike every reader in
 * `attendee.repository.ts`. Restoring somebody means opening their record
 * first, so a filter here would make the archive irreversible from the screen
 * that performs it.
 *
 * @param attendeeId - Attendee to load.
 * @param db - The pool, or the client of the transaction the read belongs to.
 * @returns The row, or `null` if no attendee has that ID under this event.
 */
export const getAttendeeForEdit = async (
  attendeeId: string,
  db: Queryable = pg,
): Promise<AttendeeAdminRow | null> => {
  const result = await db.query<AttendeeAdminRow>(
    `SELECT ${ADMIN_ROW_COLUMNS}
    FROM attendees
    WHERE attendee_id = $1
      AND event_id = $2`,
    [attendeeId, env.eventId],
  );

  return result.rows[0] ?? null;
};

/**
 * Creates an attendee.
 *
 * The first `INSERT` this application has ever made on `attendees` — see
 * migration 016, which grants exactly the columns named here.
 *
 * `attendee_id`, `ticket_link_token` and `created_at` are not named and are not
 * grantable to this role. All three carry defaults, so Postgres writes them:
 * the new attendee gets a working entry link from `004`'s default without the
 * application ever being able to choose one.
 *
 * A `23505` unique violation on `attendees_ticket_code_key` is raised, not
 * handled. The service maps it, and must not echo the driver's `detail` — it
 * names the colliding code, which may belong to another event's roster this
 * application cannot otherwise see.
 *
 * @param input - Values the service has already validated.
 * @param db - The pool, or the client of the transaction the insert joins.
 * @returns The new attendee's ID and code.
 * @throws {Error} If the statement affected no rows, which cannot happen for an
 *   `INSERT … VALUES` and is asserted rather than assumed.
 */
export const createAttendee = async (
  input: AttendeeCreateInput,
  db: Queryable = pg,
): Promise<{ attendeeId: string; ticketCode: string }> => {
  const result = await db.query<
    Pick<AttendeeEntry, 'attendee_id' | 'ticket_code'>
  >(
    `INSERT INTO attendees (
      event_id,
      ticket_code,
      attendee_name,
      attendee_phone,
      attendee_role,
      meal_option,
      drink_option,
      tshirt_size,
      lunch_option,
      tshirt_volunteer_size
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING attendee_id, ticket_code`,
    [
      env.eventId,
      input.ticketCode,
      input.attendeeName,
      input.attendeePhone,
      input.attendeeRole,
      input.mealOption,
      input.drinkOption,
      input.tshirtSize,
      input.lunchOption,
      input.tshirtVolunteerSize,
    ],
  );

  const created = result.rows[0];

  if (!created) throw new Error('Attendee insert returned no row');

  return { attendeeId: created.attendee_id, ticketCode: created.ticket_code };
};

/**
 * Replaces the editable fields of one attendee.
 *
 * Names only the eight columns the form carries, which is what keeps a save from
 * clobbering a check-in that landed while the form was open. `ticket_code` is
 * absent because it is immutable once issued — and migration 016 withholds
 * `UPDATE` on it, so that rule holds even if this statement were wrong.
 *
 * `updated_at` is left to the `attendees_set_updated_at` trigger from `006`.
 *
 * @param attendeeId - Attendee to update.
 * @param input - Values the service has already validated.
 * @returns The updated row, or `null` if no attendee has that ID under this
 *   event.
 */
export const updateAttendee = async (
  attendeeId: string,
  input: AttendeeUpdateInput,
): Promise<AttendeeAdminRow | null> => {
  const result = await pg.query<AttendeeAdminRow>(
    `UPDATE attendees
      SET attendee_name = $1,
        attendee_phone = $2,
        attendee_role = $3,
        meal_option = $4,
        drink_option = $5,
        tshirt_size = $6,
        lunch_option = $7,
        tshirt_volunteer_size = $8
    WHERE attendee_id = $9
      AND event_id = $10
    RETURNING ${ADMIN_ROW_COLUMNS}`,
    [
      input.attendeeName,
      input.attendeePhone,
      input.attendeeRole,
      input.mealOption,
      input.drinkOption,
      input.tshirtSize,
      input.lunchOption,
      input.tshirtVolunteerSize,
      attendeeId,
      env.eventId,
    ],
  );

  return result.rows[0] ?? null;
};

/**
 * Clears an attendee's chosen nickname.
 *
 * Clear only, never set: the terms of use promise the team can remove a
 * nickname, not that they can rename anybody. The grant this needs came from
 * `007` and not from the editor's own migration.
 *
 * @param attendeeId - Attendee to clear.
 * @returns The updated row, or `null` if no attendee has that ID under this
 *   event.
 */
export const clearAttendeeNickname = async (
  attendeeId: string,
): Promise<AttendeeAdminRow | null> => {
  const result = await pg.query<AttendeeAdminRow>(
    `UPDATE attendees
      SET attendee_nickname = NULL
    WHERE attendee_id = $1
      AND event_id = $2
    RETURNING ${ADMIN_ROW_COLUMNS}`,
    [attendeeId, env.eventId],
  );

  return result.rows[0] ?? null;
};

/**
 * Retires an attendee from the event, or brings them back.
 *
 * Setting `archived_at` is what every read path in `attendee.repository.ts`
 * checks, so this one column decides whether the person can check in, open
 * their pass, be served at a counter or be drawn in the raffle. It takes effect
 * on their next request rather than at their next sign-in.
 *
 * @param attendeeId - Attendee to archive or restore.
 * @param archived - Whether they should be archived.
 * @param db - The pool, or the client of the transaction the write joins.
 * @returns The updated row, or `null` if no attendee has that ID under this
 *   event.
 */
export const setAttendeeArchived = async (
  attendeeId: string,
  archived: boolean,
  db: Queryable = pg,
): Promise<AttendeeAdminRow | null> => {
  const result = await db.query<AttendeeAdminRow>(
    `UPDATE attendees
      SET archived_at = CASE WHEN $1 THEN now() ELSE NULL END
    WHERE attendee_id = $2
      AND event_id = $3
    RETURNING ${ADMIN_ROW_COLUMNS}`,
    [archived, attendeeId, env.eventId],
  );

  return result.rows[0] ?? null;
};
