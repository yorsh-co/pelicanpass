import { DependencyUnavailableError } from '../shared/errors/app-error.ts';
import { isRedisOutage } from '../shared/errors/redis-outage.ts';

import type { ErrorRequestHandler, Request } from 'express';

/** Seconds a client is asked to wait before retrying through a Redis outage. */
export const REDIS_RETRY_AFTER_SECONDS = 5;

/** The administrator pages and API, in any letter case. */
const ADMIN_PATH_RE = /^(?:\/api\/v1)?\/admin(?:[/?]|$)/i;

/**
 * Reports whether a request is for the administrator surface.
 *
 * That surface is not answered `503` for a Redis outage: it is operated by
 * staff who read the logs and `/readyz`, and its behaviour stays as it was.
 *
 * @param req - The request; its original URL is read, so this holds inside a
 *   mounted router too.
 */
export const isAdminRequest = (req: Request): boolean =>
  ADMIN_PATH_RE.test(req.originalUrl);

/**
 * The error a Redis outage is reported as.
 */
export const redisUnavailable = (): DependencyUnavailableError =>
  new DependencyUnavailableError(undefined, REDIS_RETRY_AFTER_SECONDS);

/**
 * Turns a Redis outage into a `503` the client can wait out.
 *
 * Mounted at the end of the web router and of the API router, so that a stopped
 * cache is reported to an attendee, a volunteer or a check-in visitor as "try
 * again" and not as an unexpected `500`: the error handlers log that at `error`, once per
 * request, which buries the one line that matters during an outage. Any other
 * error passes through unchanged.
 */
export const redisOutageToUnavailable: ErrorRequestHandler = (
  err: unknown,
  req,
  _res,
  next,
) => {
  next(isRedisOutage(err) && !isAdminRequest(req) ? redisUnavailable() : err);
};
