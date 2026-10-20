import type { RequestHandler } from 'express';

import { attendeeSession } from '../modules/attendee/attendee.session.adapter.ts';
import { adminSession } from '../modules/admin/admin.session.adapter.ts';
import { checkinSession } from '../modules/checkin/checkin.session.adapter.ts';
import { env } from '../config/env.ts';
import { UnauthorizedError } from '../shared/errors/app-error.ts';
import { isRedisOutage } from '../shared/errors/redis-outage.ts';
import { isAdminRequest, redisUnavailable } from './redis-outage.middleware.ts';

import type { SessionType } from '../types/session.ts';

/**
 * Resolve any valid sessions and attach them to `req.sessions`.
 * Invalid requests are to be blocked by using `requireSessionType`
 * to enforce access per route.
 */
export const resolveSessions: RequestHandler = async (req, res, next) => {
  req.sessions = {};
  req.sessionIds = {};

  try {
    const checkin = await checkinSession.get(req);
    if (checkin) {
      req.sessions.checkin = checkin.session;
      req.sessionIds.checkin = checkin.sessionId;
    }

    const attendee = await attendeeSession.get(req);
    if (attendee) {
      req.sessions.attendee = attendee.session;
      req.sessionIds.attendee = attendee.sessionId;
    }

    const admin = await adminSession.get(req);
    if (admin) {
      // The Redis TTL slides on every write, so an administrator who leaves a
      // tab open is never aged out by it. This is the ceiling that ends the
      // session regardless of activity, and it is applied here rather than in
      // the store so that both the API and the rendered pages inherit it from
      // the one place every request already passes through.
      //
      // Only admin sessions carry it: they are the only ones that exist to
      // change data deliberately, and the other two are already short.
      if (Date.now() - admin.session.createdAt > env.adminSessionMaxAge) {
        req.log.info(
          { username: admin.session.username },
          'Admin session reached its maximum age',
        );

        await adminSession.destroy(req, res);
      } else {
        req.sessions.admin = admin.session;
        req.sessionIds.admin = admin.sessionId;
      }
    }
  } catch (err) {
    // An unreachable store is not a missing session: answering 401, or sending
    // a signed-in attendee back to check-in, tells them to start over when
    // retrying is all that is needed. The admin surface keeps the old answer.
    if (isRedisOutage(err) && !isAdminRequest(req)) {
      next(redisUnavailable());

      return;
    }

    req.log.error({ err }, 'Failed to resolve sessions');

    // leave req.sessions in its current state
  }

  next();
};

/**
 * Requires a session of the given type to access an API route.
 * Must be used after `resolveSessions`. Attaches the matching
 * session to `req.session`. Returns 401 if required session is
 * missing.
 *
 * @param type - Session type the route requires.
 */
export const requireSessionType =
  (type: SessionType): RequestHandler =>
  (req, _res, next) => {
    const session = req.sessions?.[type];

    if (!session) return next(new UnauthorizedError());

    req.session = { ...session };
    req.sessionId = req.sessionIds?.[type];

    next();
  };

/**
 * Requires a session of the given type to access an web route.
 * Must be used after `resolveSessions`. Attaches the matching
 * session to `req.session`. Redirects to given route if required
 * session is missing.
 *
 * @param type - Session type the route requires.
 * @param redirectTo - Path to redirect to when the session is missing.
 */
export const requireWebAuth =
  (type: SessionType, redirectTo: string): RequestHandler =>
  (req, res, next) => {
    const session = req.sessions?.[type];

    if (!session) return res.redirect(redirectTo);

    req.session = { ...session };
    req.sessionId = req.sessionIds?.[type];

    next();
  };

/**
 * Requires that no session of the give type exists.
 * Must be used after `resolveSessions`. Redirects to
 * the given route if a session is found.
 *
 * @param type - Session type that must be absent.
 * @param redirectTo - Path to redirect to when the session is present.
 */
export const requireNoSession =
  (type: SessionType, redirectTo: string): RequestHandler =>
  (req, res, next) => {
    const session = req.sessions?.[type];

    if (session) return res.redirect(redirectTo);

    next();
  };
