import type { Request } from 'express';

import { hashUA } from '../../shared/utils/hash.ts';

import type { CheckinSession } from '../../types/session.ts';

/**
 * Builds the initial state of a check-in session.
 *
 * @param req - Request the session is being issued for.
 * @returns A complete {@link CheckinSession} at the `init` step.
 */
export const createCheckinSession = (req: Request): CheckinSession => ({
  type: 'checkin',
  version: 1,
  progress: { qr: false, ticket: false, verified: false },
  currentStep: 'init',
  source: 'direct',

  attendeeId: null,
  eventId: null,
  attendeeRole: null,

  checkinAt: null,
  checkinNumber: null,
  checkinComplete: null,

  ticket: {},
  verification: {},
  qr: {},

  attendeePreview: {},

  failedAttempts: {
    ticket: 0,
    verification: 0,
    qr: 0,
  },
  captchaRequired: false,

  ua: hashUA(req.headers['user-agent']),

  // Overwritten by session.service.ts on create and on every save; set here
  // only so the factory returns a complete CheckinSession.
  updatedAt: Date.now(),
  createdAt: Date.now(),
});
