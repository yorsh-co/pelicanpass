import { env } from '../config/env.ts';
import { ServiceUnavailableError } from '../shared/errors/app-error.ts';
import { isShedExempt } from '../shared/telemetry/load.policy.ts';
import { noteShed, shouldShed } from '../shared/telemetry/load.ts';
import { renderErrorPage } from '../web/errors/render-error-page.ts';

import type { RequestHandler } from 'express';

/**
 * Turns a public request away with `503` when the process cannot take it.
 *
 * Decided per request: while the event loop is lagging every public request is
 * refused, and otherwise only those arriving while the Postgres pool queue is
 * over its limit, so the excess is refused and the rest still served. See
 * `load.policy.ts`.
 *
 * Mounted after `/healthz`, `/readyz` and the static files, so none of those is
 * ever shed; shedding `/healthz` would have Caddy eject the only upstream.
 *
 * **Answers directly instead of calling `next(err)`.** Both error handlers log a
 * 5xx at `error` and record an event row, which is a log line and a database
 * write per rejected request at exactly the moment the process cannot afford
 * either. `res.locals.shed` is what tells `httpCounters` and the HTTP logger
 * that this 503 is a refusal rather than a failure.
 */
export const loadShed: RequestHandler = (req, res, next) => {
  if (isShedExempt(req.path) || !shouldShed()) {
    next();
    return;
  }

  noteShed();

  const { retryAfterSeconds } = env.loadShed;

  res.locals.shed = true;
  res.set('Retry-After', String(retryAfterSeconds));
  res.set('Cache-Control', 'no-store');

  renderErrorPage(
    req,
    res,
    503,
    new ServiceUnavailableError('Server busy', retryAfterSeconds),
  );
};
