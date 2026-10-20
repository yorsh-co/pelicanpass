import type { AttendeeRole } from '../types/attendee.ts';

/**
 * How the attendees editor's roster is narrowed, and what the controls read.
 *
 * The filters arrive in a request body and the list is a full page load, so
 * this module is read twice per request: once by the route, to run the query,
 * and once by the view, to re-render each control in the state the operator
 * left it. Parsing in either one alone would leave the other guessing.
 *
 * The same shape and the same reasoning as `constants/audience.ts` and its
 * `toAudienceRole`.
 */

/** How the list treats archived attendees. */
export type ArchivedFilter = 'hidden' | 'only' | 'all';

/** A parsed, settled set of roster filters. */
export interface AttendeeListFilters {
  /** Free text, trimmed and lowercased. Empty means no search. */
  q: string;

  /**
   * `null` is every role, and it is reached only by an explicit `all`.
   *
   * An absent field means `participant`, which is the default both controls
   * open on. See `ROLE_FILTERS`.
   */
  role: AttendeeRole | null;

  /** `null` is every attendee, checked in or not. */
  checkedIn: boolean | null;

  archived: ArchivedFilter;

  /** 1-based, from 1 to `MAX_PAGE`. */
  page: number;
}

/**
 * Rows per page.
 *
 * A roster runs to a few hundred, so this is about how much an operator scans
 * at once rather than about what the database can carry.
 */
export const PAGE_SIZE = 50;

/**
 * Highest page a request can name.
 *
 * Far above any roster, and low enough that `(page - 1) * PAGE_SIZE` stays a
 * small integer for the `OFFSET` it is bound to. A page past the last one is
 * answered by the repositories (no rows, the real total), not rejected here.
 */
export const MAX_PAGE = 100_000;

/** Longest search accepted, so an absurd query cannot reach `translate()`. */
const MAX_QUERY_LENGTH = 64;

/**
 * Role filter values, in the order the controls list them. Their labels are
 * `admin-shell.filter.role.*`.
 *
 * `participant` is first and is the default: the door case is a participant,
 * and a volunteer roster mixed into a phone-sized result list is noise.
 *
 * `all` rather than `''`, because an absent field now means `participant` and
 * so "both" needs a value of its own — an empty string is what `readParam`
 * answers for a field nobody submitted.
 */
export const ROLE_FILTERS = ['participant', 'all', 'volunteer'] as const;

/**
 * Check-in filter values. `''` is every attendee. Labels are
 * `admin-shell.filter.checkin.*`.
 */
export const CHECKIN_FILTERS = ['', 'yes', 'no'] as const;

/**
 * Archive filter values. `''` is `hidden`, the default. Labels are
 * `admin-shell.filter.archived.*`.
 */
export const ARCHIVED_FILTERS = ['', 'only', 'all'] as const;

/**
 * Reads one submitted field as a string.
 *
 * A urlencoded body types a field as `string | string[] | object | undefined`,
 * the same shape Express gives a query value. A repeated or nested field is
 * treated as absent, matching how `/checkin` already reads `?k=` and `?t=` —
 * and the pager depends on it: submitting `page` twice has to mean page one
 * rather than a parse error.
 *
 * @param value - Raw value from `req.body`.
 */
const readParam = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/**
 * Reads the submitted page number.
 *
 * Only a run of digits is a page: a sign, a fraction or an exponent is not, so
 * `1e9` and `1.5` answer page one rather than what `parseInt` would make of
 * them. A number above `MAX_PAGE` answers `MAX_PAGE`.
 *
 * @param value - Raw `page` field, `''` when absent.
 */
const parsePage = (value: string): number =>
  /^\d+$/.test(value) ? Math.min(Math.max(Number(value), 1), MAX_PAGE) : 1;

/**
 * Turns a submitted form into filters the repository and the view can both read.
 *
 * **These arrive in a request body, never in a query string.** Every one of
 * them describes an attendee — `q` alone is matched against the name, the
 * nickname, the ticket code and the phone digits — and a URL is written to the
 * browser's history, which outlives the session, the tailnet grant and the
 * account. `docs/security/data-retention.md` records the rule and what it costs.
 *
 * Every unrecognised value falls back to the widest sensible default rather
 * than erroring: a roster that renders unfiltered is a better answer than a
 * 400, and an empty body is how the cleared state is expressed.
 *
 * **`role` is the one exception, and it narrows rather than widens.** Anything
 * unrecognised — including an absent field — settles on `participant`, because
 * both screens are read as participant lists first and the volunteers are the
 * deliberate case. `all` is the value that opens it back up.
 *
 * @param body - `req.body`, unvalidated. Anything that is not an object — a
 *   `GET`, which reaches the handler before any parser has run — yields the
 *   cleared state.
 */
export const parseAttendeeFilters = (body: unknown): AttendeeListFilters => {
  const fields: Record<string, unknown> =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};

  const role = readParam(fields.role);
  const checkedIn = readParam(fields.checkin);
  const archived = readParam(fields.archived);

  return {
    q: readParam(fields.q).trim().toLowerCase().slice(0, MAX_QUERY_LENGTH),
    role:
      role === 'all'
        ? null
        : role === 'volunteer'
          ? 'volunteer'
          : 'participant',
    checkedIn: checkedIn === 'yes' ? true : checkedIn === 'no' ? false : null,
    archived: archived === 'only' || archived === 'all' ? archived : 'hidden',
    page: parsePage(readParam(fields.page)),
  };
};
