import { COOKIE_NAMES } from '../../constants/cookie-names.ts';
import { createSessionAdapter } from '../session/session.adapter.ts';
import { createAdminSession } from './admin.session.model.ts';

/**
 * Session helpers bound to the admin cookie and session shape.
 *
 * `sameSite: 'strict'` rather than the shared `'lax'` default. The August 2026
 * audit declined this on the grounds that there was nothing behind `/admin` to
 * protect; there now is. Nothing links into the
 * admin surface from another origin, so the stricter setting costs no
 * navigation — and it closes the Lax-plus-POST grace window that
 * `requireSameOrigin` otherwise has to cover alone.
 */
export const adminSession = createSessionAdapter(
  'admin',
  COOKIE_NAMES.admin,
  createAdminSession,
  { sameSite: 'strict' },
);
