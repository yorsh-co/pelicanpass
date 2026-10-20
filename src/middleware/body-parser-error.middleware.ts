import type { ErrorRequestHandler } from 'express';

import {
  AppError,
  ForbiddenError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../shared/errors/app-error.ts';

/**
 * Converts a body-parser failure into the `AppError` the API's `errorHandler`
 * knows how to report.
 *
 * body-parser's own errors carry an HTTP `status` and a `type`. Every 4xx is
 * the client's fault and keeps its class (400, 403, 413, 415; any other 4xx
 * becomes 400); a 5xx, and anything that is not a body-parser error, passes
 * through untouched. Without this a request the client got wrong is logged as
 * `error`, counted as `http.5xx` and can raise the 5xx alert.
 *
 * Must be mounted after the parsers and before the routes.
 */
export const normaliseBodyParserError: ErrorRequestHandler = (
  err: unknown,
  _req,
  _res,
  next,
) => {
  if (typeof err !== 'object' || err === null || err instanceof AppError) {
    return next(err);
  }

  const { type, status } = err as { type?: unknown; status?: unknown };

  if (typeof type !== 'string' || typeof status !== 'number') return next(err);

  if (status < 400 || status >= 500) return next(err);

  if (status === 413) return next(new PayloadTooLargeError());

  if (status === 403) return next(new ForbiddenError());

  if (status === 415) {
    return next(
      new UnsupportedMediaTypeError(
        type === 'encoding.unsupported'
          ? 'Unsupported content encoding'
          : type === 'charset.unsupported'
            ? 'Unsupported charset'
            : undefined,
      ),
    );
  }

  next(new ValidationError('Malformed request body'));
};
