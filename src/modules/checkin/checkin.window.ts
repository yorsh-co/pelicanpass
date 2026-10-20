import { timingSafeEqual } from 'node:crypto';

import type { Request } from 'express';

import { env } from '../../config/env.ts';
import { LANDING_BYPASS_COOKIE } from '../../constants/cookie-names.ts';
import { CheckinNotOpenError } from '../../shared/errors/app-error.ts';

import type { AttendeeRole } from '../../types/attendee.ts';

/**
 * When each audience may check in, and who is allowed past a closed window.
 *
 * One module rather than a check in each gate: the browser curtain in
 * `landing.middleware.ts`, the API gate in front of `/api/v1/checkin`, and the
 * role check inside `checkin.service.ts` are three enforcement points for one
 * rule, and three copies of the arithmetic would drift.
 *
 * Both windows are measured back from `EVENT_START_AT`, so moving the event
 * moves them together. Volunteers open first — they are the ones setting the
 * room up.
 */

/**
 * The instant an audience's check-in opens.
 *
 * @param role - Audience to resolve the window for.
 * @returns Epoch milliseconds, or `null` when there is no window at all —
 *   either the curtain is off or no event date was configured. `null` means
 *   open, and every predicate below reads it that way.
 */
export const checkinOpensAt = (role: AttendeeRole): number | null => {
  const { enabled, eventStartAt, opensBefore } = env.landing;

  if (!enabled || eventStartAt === null) return null;

  return eventStartAt - opensBefore[role];
};

/**
 * Whether a request already carries a valid bypass.
 *
 * A convenience for rehearsing the real flow during a closed window, not a
 * security boundary — but compared in constant time anyway, because a plain
 * `===` on a secret is the kind of thing that gets copied into somewhere it
 * does matter.
 *
 * @param req - Request to read the bypass cookie from.
 */
export const hasLandingBypass = (req: Request): boolean => {
  const expected = env.landing.bypassToken;

  if (expected === undefined) return false;

  // cookie-parser types req.cookies as `any`, so the value is asserted to the
  // only thing a cookie can be.
  const cookies = req.cookies as Record<string, string | undefined>;

  return isBypassToken(cookies[LANDING_BYPASS_COOKIE]);
};

/**
 * Whether a candidate matches the configured bypass token.
 *
 * Exported for the middleware, which has to check the `?preview=` parameter
 * before there is a cookie to read.
 *
 * @param candidate - Value presented by the request.
 */
export const isBypassToken = (candidate: unknown): boolean => {
  const expected = env.landing.bypassToken;

  if (expected === undefined || typeof candidate !== 'string') return false;

  const presented = Buffer.from(candidate);
  const secret = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, which would leak the length
  // through the error rather than through the timing.
  if (presented.length !== secret.length) return false;

  return timingSafeEqual(presented, secret);
};

/**
 * Whether an audience may check in right now.
 *
 * @param role - Audience being admitted.
 * @param req - Request, so a held bypass counts as open.
 */
export const isCheckinOpen = (role: AttendeeRole, req: Request): boolean => {
  const opensAt = checkinOpensAt(role);

  if (opensAt === null) return true;

  return Date.now() >= opensAt || hasLandingBypass(req);
};

/**
 * Whether *any* audience may check in right now.
 *
 * What the API gate reads. Before the earlier of the two windows nothing can
 * legitimately be checked in, and that is decidable without touching the
 * database — which is the whole point of asking it there.
 *
 * @param req - Request, so a held bypass counts as open.
 */
export const isAnyCheckinOpen = (req: Request): boolean =>
  isCheckinOpen('volunteer', req) || isCheckinOpen('participant', req);

/**
 * Refuses a check-in attempted before that attendee's window opens.
 *
 * Called once the attendee row has resolved, so it reads the role recorded in
 * Postgres rather than the `?audience=` the browser asked for. That parameter
 * only selects copy; anyone can type it.
 *
 * @param role - Role from the resolved attendee row.
 * @param req - Request, so a held bypass counts as open.
 * @throws {CheckinNotOpenError} If the window has not opened.
 */
export const assertCheckinOpen = (
  role: AttendeeRole | null | undefined,
  req: Request,
): void => {
  // A lookup that produced no role never reached an attendee, and the error
  // that fact deserves is raised by the lookup itself.
  if (!role) return;

  if (!isCheckinOpen(role, req)) {
    throw new CheckinNotOpenError();
  }
};
