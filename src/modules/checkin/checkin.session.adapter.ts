import { COOKIE_NAMES } from '../../constants/cookie-names.ts';
import { createSessionAdapter } from '../session/session.adapter.ts';
import { createCheckinSession } from './checkin.session.model.ts';

/** Session helpers bound to the check-in cookie and session shape. */
export const checkinSession = createSessionAdapter(
  'checkin',
  COOKIE_NAMES.checkin,
  createCheckinSession,
);
