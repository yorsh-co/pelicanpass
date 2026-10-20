import type { Request } from 'express';

import { hashUA } from '../../shared/utils/hash.ts';

import type { AttendeeSession } from '../../types/session.ts';

/**
 * Builds the initial state of an attendee session.
 *
 * `attendeeId` and `attendeeRole` are left null here and supplied through the
 * adapter's `overrides` argument at creation time, since the attendee is only
 * known to the caller issuing the session.
 *
 * @param req - Request the session is being issued for.
 * @returns A complete {@link AttendeeSession}.
 */
export const createAttendeeSession = (req: Request): AttendeeSession => ({
  type: 'attendee',
  version: 1,

  attendeeId: null,
  attendeeRole: null,

  ua: hashUA(req.headers['user-agent']),

  // Overwritten by session.service.ts on create and on every save; set here
  // only so the factory returns a complete AttendeeSession.
  updatedAt: Date.now(),
  createdAt: Date.now(),
});
