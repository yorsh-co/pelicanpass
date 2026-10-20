import type { RequestHandler } from 'express';

import { UnsupportedMediaTypeError } from '../shared/errors/app-error.ts';

/**
 * Media types the API router mounts a body parser for.
 *
 * One entry, and it has to stay in step with `api/index.ts` by hand — an
 * earlier note here claimed this list was derived from the parsers, which it
 * never was.
 */
const PARSED_TYPES = ['json'];

/**
 * Rejects a request that declares a `Content-Type` no mounted parser handles.
 * Returns 415 before the session lookup and captcha check.
 *
 * A missing `Content-Type` is allowed through.
 */
export const requireSupportedContentType: RequestHandler = (
  req,
  _res,
  next,
) => {
  if (req.headers['content-type'] === undefined) return next();

  if (req.is(PARSED_TYPES)) return next();

  next(new UnsupportedMediaTypeError());
};
