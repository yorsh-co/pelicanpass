import type { SessionType } from '../types/session.ts';

/**
 * Single source of truth for session cookie names. Referenced by
 * session adapters, session-keyed rate limiters, and debug routes
 * so the raw string only appears here.
 */
export const COOKIE_NAMES: Record<SessionType, string> = {
  checkin: 'checkin_session_id',
  attendee: 'attendee_session_id',
  admin: 'admin_session_id',
};

/**
 * Cookie recording that a request already presented `LANDING_BYPASS_TOKEN`.
 *
 * Not a session, which is why it sits beside {@link COOKIE_NAMES} rather than
 * in it: it carries no state and resolves nothing. It exists because the
 * check-in flow strips its own query parameters — the `?t=` entry redirects,
 * and the browser rewrites the URL again on boot — so a bypass carried in the
 * URL would survive exactly one request.
 */
export const LANDING_BYPASS_COOKIE = 'landing_bypass';

/**
 * Cookie holding the locale chosen with `?lang=`.
 *
 * A preference, not a session: it outlives the browser session and is declared
 * as such in the privacy notice.
 */
export const LOCALE_COOKIE = 'locale';
