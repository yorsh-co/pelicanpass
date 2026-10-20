import type { CookieOptions, RequestHandler } from 'express';

import { env } from '../config/env.ts';
import { toAudienceRole } from '../constants/audience.ts';
import { LANDING_BYPASS_COOKIE } from '../constants/cookie-names.ts';
import {
  checkinOpensAt,
  hasLandingBypass,
  isAnyCheckinOpen,
  isBypassToken,
} from '../modules/checkin/checkin.window.ts';
import {
  CheckinNotOpenError,
  EventClosedError,
} from '../shared/errors/app-error.ts';
import { withoutQueryParam } from '../shared/utils/url.ts';
import { closingView, landingView } from '../web/landing/landing-view.ts';

/**
 * The pre-event curtain, in front of the browser pages and in front of the
 * check-in API.
 *
 * Two gates because `?audience=` is self-declared. The curtain decides which
 * countdown to draw from it, which is all it is for — the API gate never reads
 * it, and the role check inside `checkin.service.ts` reads Postgres instead.
 */

/**
 * Paths the curtain covers.
 *
 * An allowlist rather than "everything that is not `/admin`", for two reasons.
 * `/admin` stays exempt by construction rather than by a prefix test that a
 * later route could slip past, and an unknown path keeps answering a real 404
 * instead of a 200 curtain that says the URL was fine.
 *
 * `/privacy` and `/terms` are absent because they are mounted above this in
 * `web.routes.ts` and never reach it.
 */
const GATED_PATHS = new Set(['/', '/pass', '/checkin', '/staff', '/raffle']);

/**
 * Options the bypass cookie is written with.
 *
 * Mirrors the session cookie in `session.adapter.ts` but takes a `maxAge` that
 * one deliberately omits: there is no sliding TTL behind this to outlive, and a
 * rehearsal key that survives until the browser is closed is a rehearsal key
 * still in the room during the event.
 */
const BYPASS_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: env.nodeEnv === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 2 * 60 * 60 * 1000,
};

/**
 * Whether `EVENT_CLOSES_AT` has passed.
 *
 * @param now - Epoch milliseconds to test against.
 */
export const isEventClosed = (now = Date.now()): boolean =>
  env.landing.closesAt !== null && now >= env.landing.closesAt;

/**
 * Replaces the gated pages with the closing page once the event has closed.
 *
 * Mounted above `resolveSessions`, so a request after the event costs no
 * session lookup. Unlike {@link landingGate} it honours neither a held
 * attendee session nor the bypass: past this point there is nothing left for
 * either to open. `/admin` stays reachable for the teardown's exports.
 */
export const closingGate: RequestHandler = (req, res, next) => {
  if (!GATED_PATHS.has(req.path) || !isEventClosed()) return next();

  // The page is permanent once drawn, but a rehearsal moves the variable back.
  res.setHeader('Cache-Control', 'no-store');

  res.render(
    'pages/closing',
    closingView({ locale: res.locals.locale, appTitle: env.appTitle }),
  );
};

/**
 * Stands the landing page in front of the app until check-in opens.
 *
 * Mounted after `resolveSessions` and ahead of every route, which buys three
 * things: an attendee who already checked in is recognised, `/checkin` never
 * charges a gated request against `checkinEntryIpLimiter`, and the two pages
 * mounted above `resolveSessions` need no special case here.
 */
export const landingGate: RequestHandler = (req, res, next) => {
  if (!env.landing.enabled) return next();

  if (!GATED_PATHS.has(req.path)) return next();

  // A volunteer checks in four hours early and then holds a pass. Locking them
  // out again while the participant window is still closed would take away the
  // thing they just spent the queue on.
  if (req.sessions?.attendee) return next();

  const preview = req.query.preview;

  // Exchanged for a cookie and dropped from the URL: the check-in flow strips
  // its own query string twice over, so a bypass that lived in the URL would
  // last exactly one request.
  if (typeof preview === 'string' && isBypassToken(preview)) {
    res.cookie(LANDING_BYPASS_COOKIE, preview, BYPASS_COOKIE_OPTIONS);

    req.log.warn('Landing bypass presented - opening check-in for this client');

    return res.redirect(303, withoutQueryParam(req.originalUrl, 'preview'));
  }

  if (hasLandingBypass(req)) return next();

  const audience = toAudienceRole(req.query.audience) ?? 'participant';
  const opensAt = checkinOpensAt(audience);

  if (opensAt === null || Date.now() >= opensAt) return next();

  res.render(
    'pages/landing',
    landingView({
      opensAt,
      now: Date.now(),
      audience,
      locale: res.locals.locale,
      timezone: env.landing.timezone,
      appTitle: env.appTitle,
      fallback: false,
    }),
  );
};

/**
 * Refuses check-in API calls made before any window has opened.
 *
 * The cheap half of the API gate: before the earlier of the two windows nothing
 * can legitimately be checked in, and saying so here costs no database round
 * trip and charges nothing against the entry failure budget. The window between
 * the two — volunteers in, participants not — needs the attendee's real role
 * and is enforced in `checkin.service.ts`.
 */
export const checkinWindowGate: RequestHandler = (req, _res, next) => {
  if (isAnyCheckinOpen(req)) return next();

  next(new CheckinNotOpenError());
};

/**
 * Refuses the attendee-facing API once the event has closed.
 *
 * The API half of {@link closingGate}. Mounted before `resolveSessions`, so a
 * poll from a pass left open costs no session lookup.
 */
export const eventClosedGate: RequestHandler = (_req, _res, next) => {
  if (!isEventClosed()) return next();

  next(new EventClosedError());
};
