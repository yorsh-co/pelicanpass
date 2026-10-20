import type { RequestHandler } from 'express';

import {
  count,
  observeFanout,
  observeLatency,
} from '../shared/telemetry/counters.ts';
import { normaliseRoute } from '../shared/telemetry/record.ts';
import { maskUrlSecrets } from '../shared/utils/mask.ts';

/**
 * Counts completed requests by outcome, times them, and records the per-address
 * session fan-out.
 *
 * A separate middleware rather than a side effect inside pino-http's
 * `customLogLevel`: that hook is called once per response and would work, but a
 * function whose job is choosing a log level should not also be mutating
 * counters. `finish` gives the same single call per response, honestly.
 *
 * It is also the only hook that *can* do the last two jobs. pino-http computes
 * `responseTime` for its own log line and never exposes it, so the duration is
 * measured here; and `resolveSessions` runs inside the API router, well after
 * this middleware is mounted, so `req.sessionIds` is empty on the way in and
 * populated by the time `finish` fires.
 *
 * Registered beside `httpLogger` and therefore ahead of the routers, so it sees
 * every response including 404s and rate-limit refusals — the two that matter
 * most here.
 */
export const httpCounters: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    count('http.req');

    // A shed 503 is a refusal the process chose, not a failure, and the 5xx
    // alert says "failing outright, not being refused politely".
    if (res.locals.shed) count('http.shed');
    else if (res.statusCode >= 500) count('http.5xx');
    else if (res.statusCode === 429) count('http.429');
    else if (res.statusCode >= 400) count('http.4xx');

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    // Masked before normalised: the entry link carries `?t=<token>` and the
    // poster QR carries `?k=`, and a histogram key is as much a place for a
    // credential to end up as a log line is.
    const route = normaliseRoute(maskUrlSecrets(req.originalUrl));

    // A shed answers in about a millisecond. Timing it would pull the latency
    // panel towards "fast" at the one moment served requests are slow.
    if (!res.locals.shed) observeLatency(route, durationMs);

    // Door traffic, as distinct from all traffic.
    //
    // The door-stalled rule needs "somebody is trying to check in", and
    // `http.req` is not that: this middleware runs ahead of the routers, so it
    // counts static assets, the health probe and the metrics dashboard's own
    // five-second poll. Measured, that poll alone is 36 requests across the
    // rule's three-minute window against a threshold of 30 — an open dashboard
    // was enough to raise a critical alert with nothing at the door at all.
    //
    // Counted regardless of status code, deliberately. A `/checkin` answering
    // 500 because Redis is gone is precisely the traffic the rule exists to
    // notice; filtering to successes would blind it to its own reason for being.
    if (route.startsWith('/checkin') || route.startsWith('/api/v1/checkin')) {
      count('checkin.req');
    }

    // Fan-out is per address, so it needs one. Anything reaching this without
    // one is not something a CGNAT question is asked about.
    const ip = req.ip;

    if (!ip) return;

    // Any session on the request will do — the question is how many distinct
    // ones an address carries, not which kind. A request with no session at all
    // contributes nothing, which is correct: an address that has never held one
    // has a fan-out of zero rather than an unknown.
    for (const sessionId of Object.values(req.sessionIds ?? {})) {
      if (sessionId) observeFanout(ip, sessionId);
    }
  });

  next();
};
