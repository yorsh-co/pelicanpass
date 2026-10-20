import { COOKIE_NAMES } from '../../constants/cookie-names.ts';
import { createSessionAdapter } from '../session/session.adapter.ts';
import { createAttendeeSession } from './attendee.session.model.ts';

/** Session helpers bound to the attendee cookie and session shape. */
export const attendeeSession = createSessionAdapter(
  'attendee',
  COOKIE_NAMES.attendee,
  createAttendeeSession,
);
