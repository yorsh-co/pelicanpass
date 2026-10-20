import type { ErrorRequestHandler } from 'express';

import {
  AppError,
  DependencyUnavailableError,
} from '../shared/errors/app-error.ts';
import { applyRateLimitHeader } from '../shared/errors/apply-rate-limiter-header.ts';
import { actorOf } from '../shared/telemetry/actor.ts';
import { recordEvent } from '../shared/telemetry/record.ts';
import { maskUrlSecrets } from '../shared/utils/mask.ts';

import type { AppErrorCode } from '../types/appErrorCode.ts';

/**
 * Central JSON error handler for the API router. Must be registered
 * last, after all `/api/v1` routes.
 *
 * AppError instances are operational: logged at warn (a 5xx one at error,
 * except {@link DependencyUnavailableError}, an outage reported elsewhere), and their
 * message/code/details are safe to send to the client as-is.
 * Anything else is unexpected: logged at error with the full stack,
 * and reported to the client as a generic 500 with no internal detail.
 *
 * `err` is typed `unknown` rather than Express's `any`, because anything can
 * be thrown and only `AppError` may reach the client unchanged.
 */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req,
  res,
  next,
) => {
  if (res.headersSent) return next(err);

  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;

  const code: AppErrorCode = isAppError ? err.code : 'INTERNAL_ERROR';

  const logPayload = {
    method: req.method,
    path: maskUrlSecrets(req.originalUrl),
    statusCode,
    code,
    message: err instanceof Error ? err.message : String(err),
    sessionType: req.session?.type,
  };

  const stack = err instanceof Error ? err.stack : undefined;
  const degraded = err instanceof DependencyUnavailableError;

  // Read by `httpLogger` for the response line, so the outage is a warning in
  // both of the request's log lines.
  if (degraded) res.locals.degraded = true;

  if ((isAppError && statusCode < 500) || degraded) {
    req.log.warn(logPayload, 'Request error');
  } else {
    req.log.error({ ...logPayload, stack }, 'Unexpected error');
  }

  // A second sink, not a second log line — recordEvent does not log, precisely
  // so the two calls above stay the only record in the file.
  recordEvent({
    severity: (isAppError && statusCode < 500) || degraded ? 'warn' : 'error',
    kind: 'http_error',
    code,
    message: logPayload.message,
    route: logPayload.path,
    statusCode,
    requestId: typeof req.id === 'string' ? req.id : undefined,
    stack,
    ...actorOf(req),
  });

  applyRateLimitHeader(err, res);

  res.status(statusCode).json({
    success: false,
    error: isAppError ? err.message : 'Internal server error',
    code,
    ...(isAppError && err.details ? { details: err.details } : {}),
  });
};
