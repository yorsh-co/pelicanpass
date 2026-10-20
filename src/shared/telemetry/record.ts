import { createHash } from 'node:crypto';

import { sendAlert } from './alerts.ts';
import { enqueueEvent } from './events.ts';
import type { TelemetryFields } from './scrub.ts';
import { count } from './counters.ts';

/**
 * How bad an occurrence is. Mirrors the pino levels the call sites already use,
 * so a line logged at `warn` records at `warn`.
 */
export type EventSeverity = 'info' | 'warn' | 'error' | 'fatal';

/**
 * What kind of thing happened, which is what the dashboard groups by later.
 */
export type EventKind = 'http_error' | 'client_error' | 'security' | 'domain';

export interface RecordedEvent {
  readonly severity: EventSeverity;
  readonly kind: EventKind;
  /** `AppErrorCode`, or `UNCAUGHT` for something that escaped a handler. */
  readonly code?: string | undefined;
  readonly message: string;
  readonly route?: string | undefined;
  readonly statusCode?: number | undefined;
  readonly requestId?: string | undefined;
  readonly stack?: string | undefined;
  /**
   * `anon`, or the `SessionType` the request carried. Deliberately the session
   * taxonomy rather than a role one.
   */
  readonly actorType?: string | undefined;
  /** An id. Never a name, and never a ticket code. */
  readonly actorId?: string | undefined;
  readonly ip?: string | undefined;
  /** Must be free of personal data — the boundary censors, it does not fix. */
  readonly fields?: TelemetryFields | undefined;
}

/**
 * Fingerprints seen since boot, for the "this is new" rule.
 *
 * Resetting on restart is correct rather than a limitation: a fingerprint that
 * reappears after a deploy is worth announcing again, because the deploy is the
 * most likely thing to have caused it.
 *
 * Bounded for the same reason the suppression map is — a fingerprint derives
 * partly from request shape.
 */
const seen = new Set<string>();
const MAX_SEEN = 2_000;

/**
 * Collapses the varying parts of a path so two requests to the same handler
 * fingerprint alike.
 *
 * Runs against an already-masked URL, so it is shaping rather than redacting.
 *
 * Exported for the latency histogram's route labels. The two have to agree: a
 * second normaliser would file one route under two names, so the graph and the
 * error grouping would disagree about what a route is.
 */
export const normaliseRoute = (route: string): string =>
  route
    .split('?')[0]
    ?.replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '/:id',
    )
    .replace(/\/\d+/g, '/:n') ?? route;

/**
 * The frame that identifies where an error came from.
 *
 * Skips `node_modules`, because the deepest frame is usually somewhere inside
 * Express and identical for every unrelated failure — fingerprinting on it
 * would collapse distinct bugs into one group.
 */
const originFrame = (stack: string | undefined): string => {
  if (!stack) return '';

  for (const line of stack.split('\n').slice(1)) {
    if (!line.includes('node_modules') && line.includes('at ')) {
      return line.trim();
    }
  }

  return '';
};

/**
 * Stable identity for a class of failure, not an occurrence of one.
 *
 * This is what groups the dashboard's error panel and what keys alert
 * deduplication, so it has to be stable across requests and distinct across
 * causes.
 */
export const fingerprintOf = (event: RecordedEvent): string =>
  createHash('sha256')
    .update(
      [
        event.code ?? '',
        event.kind,
        normaliseRoute(event.route ?? ''),
        originFrame(event.stack),
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 16);

/**
 * Records one occurrence into every telemetry sink.
 *
 * **Deliberately does not log.** Every call site already writes a pino line
 * through `req.log`, and logging here too would double every error in the file
 * this project just made durable. This is the seam for the sinks pino is not:
 * the counters now, the `app_events` table next.
 *
 * Never throws. A telemetry failure must not become a request failure, so the
 * whole body is defensive — the caller is on a hot path and has already done
 * the thing worth recording.
 *
 * @param event - What happened.
 * @returns The fingerprint, so a caller can put it in its own log line.
 */
export const recordEvent = (event: RecordedEvent): string => {
  const fingerprint = fingerprintOf(event);

  try {
    count(`event.${event.kind}`);
    count(`severity.${event.severity}`);

    // `domain` is counted and not stored. A completed check-in and a recorded
    // redemption already have durable homes in `attendees` and `redemptions`,
    // and a second copy here would be a second source of truth about the
    // evening that nobody reconciles.
    if (event.kind !== 'domain') {
      enqueueEvent({
        severity: event.severity,
        kind: event.kind,
        code: event.code,
        fingerprint,
        message: event.message,
        route: event.route,
        statusCode: event.statusCode,
        requestId: event.requestId,
        actorType: event.actorType,
        actorId: event.actorId,
        ip: event.ip,
        fields: event.fields,
      });
    }

    const isFailure = event.severity === 'error' || event.severity === 'fatal';

    if (isFailure && !seen.has(fingerprint)) {
      if (seen.size >= MAX_SEEN) seen.clear();

      seen.add(fingerprint);

      sendAlert({
        severity: event.severity === 'fatal' ? 'critical' : 'warn',
        title: 'New error, first time since boot',
        fingerprint: `new:${fingerprint}`,
        means:
          'A failure with a shape not seen since the process started. Fires once per shape, so a burst of these right after a deploy means the deploy.',
        check:
          'The Errors panel — this signature will be there with its count and last occurrence.',
        fields: {
          code: event.code ?? 'UNKNOWN',
          route: normaliseRoute(event.route ?? '—'),
          status: event.statusCode ?? 0,
          message: event.message.slice(0, 200),
          signature: fingerprint,
        },
      });
    }
  } catch {
    // Intentionally silent. Logging here risks recursing through an error
    // handler that is itself the caller.
  }

  return fingerprint;
};
