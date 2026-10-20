import type { Response } from 'express';

import { AppError } from './app-error.ts';

/**
 * Sets the Retry-After header on the response if the given error is
 * a rate-limit or service-unavailable AppError carrying a retryAfterSeconds
 * value. Shared
 * between error.middleware.js (JSON) and app.js's catch-all (plain
 * text), which otherwise can't share a single Express error handler
 * since their response formats differ.
 *
 * @param err - Any thrown value; only those two AppErrors set the header.
 * @param res - Response to set the header on.
 */
export const applyRateLimitHeader = (err: unknown, res: Response): void => {
  if (!(err instanceof AppError)) return;

  const waits =
    err.code === 'RATE_LIMITED' || err.code === 'SERVICE_UNAVAILABLE';

  if (waits && err.details?.retryAfterSeconds) {
    res.set('Retry-After', String(err.details.retryAfterSeconds));
  }
};
