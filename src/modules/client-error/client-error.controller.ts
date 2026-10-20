import { count } from '../../shared/telemetry/counters.ts';
import { actorOf } from '../../shared/telemetry/actor.ts';
import { recordEvent } from '../../shared/telemetry/record.ts';
import { consumeClientErrorBudget } from '../../middleware/rate.middleware.ts';
import {
  RateLimitError,
  ValidationError,
} from '../../shared/errors/app-error.ts';
import { maskUrlSecrets } from '../../shared/utils/mask.ts';

import type { RequestHandler } from 'express';

/**
 * Ingest for errors that happened in somebody's browser.
 *
 * Until this existed, a frontend break on seven hundred phones was invisible
 * until a volunteer walked over and said so. Reports land as `client_error`
 * through the same `recordEvent` seam as everything else, so they reach the same
 * table, the same dashboard panel and the same alert rules with no parallel
 * machinery — which is what the phase-2 work bought.
 */

/** Longest message kept. Anything past this is a stack that lost its way. */
const MAX_MESSAGE = 500;

/** Longest stack kept. Deep enough to identify a frame, bounded for the table. */
const MAX_STACK = 4_000;

/** Longest URL kept, after masking. */
const MAX_URL = 500;

/** Longest error name kept. */
const MAX_NAME = 100;

/**
 * What a report may contain.
 *
 * An allow-list rather than a shape check: this is an unauthenticated write, so
 * a field nobody named is a field nobody validated, and `context` is a `jsonb`
 * column that would happily store it.
 */
interface ClientErrorReport {
  message: string;
  url: string;
  /** Explicitly `| undefined`, the repo convention under
      `exactOptionalPropertyTypes`: a bare `?` would mean "absent", not
      "present and undefined". */
  name?: string | undefined;
  stack?: string | undefined;
  line?: number | undefined;
  col?: number | undefined;
  releaseId?: string | undefined;
  requestId?: string | undefined;
}

/** A bounded string field; `\u0000` is removed because Postgres refuses it. */
const str = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;

  const clean = value.replaceAll('\u0000', '');

  return clean.length > 0 ? clean.slice(0, max) : undefined;
};

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Reads a report out of a request body, keeping only what is named.
 *
 * @param body - Whatever the parser left behind.
 * @returns The report, or `null` if the two required fields are missing.
 */
const parseReport = (body: unknown): ClientErrorReport | null => {
  if (typeof body !== 'object' || body === null) return null;

  const raw = body as Record<string, unknown>;

  const message = str(raw.message, MAX_MESSAGE);
  const url = str(raw.url, MAX_URL);

  if (!message || !url) return null;

  return {
    message,
    // Masked here rather than at the sink, because this is the boundary the
    // untrusted value crosses. `?t=` is the entry-link token an attendee
    // arrives on and is a live credential; `?k=` is the poster token and is
    // deliberately left visible — docs/security/data-retention.md records why.
    url: maskUrlSecrets(url),
    name: str(raw.name, MAX_NAME),
    stack: str(raw.stack, MAX_STACK),
    line: num(raw.line),
    col: num(raw.col),
    releaseId: str(raw.releaseId, 40),
    requestId: str(raw.requestId, 64),
  };
};

/**
 * Accepts one client error report.
 *
 * Answers 204 rather than a body: the reporter has nothing to do with the
 * result, and on the `pagehide` path there is no page left to read it.
 */
export const report: RequestHandler = async (req, res, next) => {
  try {
    const budget = await consumeClientErrorBudget(req.ip ?? 'unknown');

    if (budget.blocked) {
      throw new RateLimitError('Too many reports', budget.retryAfterSeconds);
    }

    const parsed = parseReport(req.body);

    if (!parsed) throw new ValidationError('Malformed error report');

    req.log.warn(
      {
        clientMessage: parsed.message,
        url: parsed.url,
        clientRelease: parsed.releaseId,
      },
      'Client error reported',
    );

    // The Erros panel has graphed a permanent zero for this counter since phase
    // 3, because nothing incremented it until now.
    count('client.error');

    // `warn`, not `error`, and the difference matters: recordEvent raises a
    // "New error signature" alert for the first sighting of anything `error` or
    // worse, so on seven hundred phones one browser extension could page
    // somebody at 20:00. The spike rule in rules.ts owns the alerting for this,
    // the same division admin.service.ts already uses for its login budget.
    recordEvent({
      severity: 'warn',
      kind: 'client_error',
      code: parsed.name ?? 'CLIENT_ERROR',
      message: parsed.message,
      route: parsed.url,
      stack: parsed.stack,
      requestId: parsed.requestId,
      ...actorOf(req),
      fields: {
        clientRelease: parsed.releaseId ?? 'unknown',
        line: parsed.line ?? 0,
        col: parsed.col ?? 0,
      },
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
};
