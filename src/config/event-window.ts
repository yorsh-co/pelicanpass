import { duration, optional, read, timestamp } from './read-env.ts';

import type { AttendeeRole } from '../types/attendee.ts';

/**
 * The event-timing variables, read one way for both processes that need them.
 *
 * The live app and the standalone landing fallback must open the same window
 * at the same instant from the same `.env` lines. One reader is what stops a
 * default or a variable name drifting between them.
 */

/**
 * How long before `EVENT_START_AT` each audience may check in.
 *
 * @throws {Error} If either variable is set to something unparseable.
 */
export const readOpensBefore = (): Record<AttendeeRole, number> => ({
  participant: duration('CHECKIN_OPENS_BEFORE_PARTICIPANT', 30 * 60_000),
  volunteer: duration('CHECKIN_OPENS_BEFORE_VOLUNTEER', 4 * 3_600_000),
});

/** Timezone the landing page prints the absolute open time in. */
export const readEventTimezone = (): string =>
  optional('EVENT_TIMEZONE', 'America/Sao_Paulo');

/**
 * The instant the event closes, from `EVENT_CLOSES_AT`.
 *
 * From then on every public page shows the closing page and the attendee API
 * refuses. Independent of `LANDING_ENABLED`: the pre-event curtain and the
 * post-event one are switched separately.
 *
 * @returns Epoch milliseconds, or `null` when unset — the event never closes.
 * @throws {Error} If the variable is set but carries no offset or is malformed.
 */
export const readEventClosesAt = (): number | null =>
  read('EVENT_CLOSES_AT') !== undefined ? timestamp('EVENT_CLOSES_AT') : null;
