import { request } from './api.request.ts';

import type { SurveyOverview } from '../../../../types/survey.ts';
import type { TicketLimitOverview } from '../../../../types/ticket-limit.ts';

/**
 * The live panel's one read.
 *
 * Typed loosely on purpose: every field is a claim off the wire, and the page
 * renders whatever arrived rather than asserting a shape the server might have
 * changed under it. The server-rendered first paint is the contract; this is
 * the refresh.
 */
export interface MetricsSnapshot {
  generatedAt: string;
  release: string;
  uptimeSeconds: number;
  windows: { role: string; opensAt: string | null; open: boolean }[];
  lastAlert: { severity: string; title: string; at: string } | null;
  series: Record<string, number[]>;
  limiters: {
    name: string;
    ceiling: number | null;
    peak: number;
    consumed: number;
    refused: number;
    topKeys: { key: string; points: number }[];
    duration: number | null;
    basis: string | null;
    keyedOn: string | null;
    protects: string | null;
    tier: 'strict' | 'trusted' | null;
  }[];
  fanout: { ip: string; sessions: number }[];
  latency: Record<
    string,
    { p50: number | null; p95: number | null; count: number }
  >;
  health: {
    redis: { ok: boolean; durationMs: number; error?: string };
    postgres: { ok: boolean; durationMs: number; error?: string };
  };
  topErrors: {
    fingerprint: string;
    code: string | null;
    route: string | null;
    message: string;
    occurrences: number;
    lastSeen: string;
  }[];
  redemptions: { item: string; outcome: string; total: number }[];
  checkins: { attendeeRole: string; checkedIn: number; expected: number }[];
  checkinPrefixes: {
    prefix: string;
    checkedIn: number;
    expected: number;
  }[];
  ticketLimit: TicketLimitOverview | null;
  survey: SurveyOverview | null;
}

interface Envelope<T> {
  data?: T;
}

/** What `/readyz` reports. Same shape as the snapshot's `health`. */
export interface Readiness {
  status: 'ready' | 'degraded';
  release: string;
  dependencies: MetricsSnapshot['health'];
}

/**
 * Whether both probes are present and shaped the way the panel reads them.
 *
 * The `dependencies` check alone is not enough: `{ "dependencies": {} }`
 * satisfies it and then throws on `health.redis.ok` inside the renderer, which
 * is the one moment the dashboard is being asked what is wrong.
 *
 * @param deps - The `dependencies` object, already known to be non-null.
 * @returns Whether it carries both probes with a boolean `ok`.
 */
const hasProbes = (deps: object): boolean =>
  ['redis', 'postgres'].every((name) => {
    const probe = (deps as Record<string, unknown>)[name];

    return (
      typeof probe === 'object' &&
      probe !== null &&
      typeof (probe as { ok?: unknown }).ok === 'boolean'
    );
  });

/**
 * How long the readiness probe waits before reporting that nothing answered.
 *
 * Its own, since the probe bypasses `request()`, and it must outlast the
 * server's bound. Under pool saturation `/readyz` can spend 5 s waiting for a
 * connection (`connectionTimeoutMillis`) and 5 s more on `SELECT 1`
 * (`query_timeout`), both set in `src/shared/db/postgres.ts`. Giving up sooner
 * would turn "Postgres is slow", the diagnosis this exists for, into "nothing
 * answered".
 */
const READINESS_TIMEOUT_MS = 12_000;

/**
 * Asks the server which dependencies are answering.
 *
 * **Deliberately not through `request()`**, and not under `/api/v1`. This is the
 * one read that has to work when the snapshot cannot: the snapshot sits behind
 * `requireSessionType('admin')`, sessions live in Redis, so a Redis outage
 * answers 401 and the dashboard would report "disconnected" for the single
 * outage it most needs to name. `/readyz` takes no session, touches both
 * dependencies directly, and says which one failed.
 *
 * Answers 503 when something is down, which is a normal outcome here rather
 * than an error — so the status is read rather than thrown on.
 *
 * @returns The report; `'refused'` when something answered but would not let
 *   the probe through, which on the public hostname is the normal answer —
 *   Caddy 403s `/readyz` there by design, so the body is not JSON and the parse
 *   below would otherwise report it as nothing answering; `'unavailable'` when
 *   the app answered with something else, such as the 429 from its own rate
 *   limiter; `null` when nothing answered at all. The four are different
 *   diagnoses and must not collapse: an app that refuses a probe is emphatically
 *   not an app that is down.
 */
export const readiness = async (): Promise<
  Readiness | 'refused' | 'unavailable' | null
> => {
  // A bare abort, with no flag beside it: the catch below reads every rejection
  // as "nothing answered", so a timeout needs no name of its own.
  const controller = new AbortController();
  const timer = window.setTimeout(() => {
    controller.abort();
  }, READINESS_TIMEOUT_MS);

  try {
    // `omit`, not the default. This endpoint takes no session and needs no
    // cookie, and saying so keeps it that way: a relative path is same-origin
    // today, but `include` on a URL that later became absolute would post the
    // administrator's session cookie somewhere it was never meant to go.
    const res = await fetch('/readyz', {
      credentials: 'omit',
      signal: controller.signal,
    });

    // Read before parsing. A 403 here is the edge refusing the probe, not the
    // app failing one — `Caddyfile` blocks `/readyz` on the public hostname so
    // it cannot be used to enumerate dependencies from the internet. Its body
    // is not JSON, so without this the parse throws and the outage reads as
    // "nothing answered", which is a plain untruth about a healthy app.
    //
    // 503 is deliberately not caught here: that is the app answering, with the
    // report, which is the whole point of the endpoint.
    if (res.status === 403) return 'refused';

    const body: unknown = await res.json();

    // Validated rather than cast. A 503 carrying the report is the *expected*
    // outage answer, but this endpoint can also answer 429 now that it is rate
    // limited, and that body has no `dependencies` at all. Trusting the cast
    // would push a `TypeError` into the caller and lose the diagnosis at
    // precisely the moment it was being asked for.
    if (
      typeof body !== 'object' ||
      body === null ||
      !('dependencies' in body) ||
      typeof body.dependencies !== 'object' ||
      body.dependencies === null ||
      !hasProbes(body.dependencies)
    ) {
      return 'unavailable';
    }

    return body as Readiness;
  } catch {
    // Not a dependency problem: nothing answered at all, or not in time.
    return null;
  } finally {
    // After the body read, which the same signal bounds.
    window.clearTimeout(timer);
  }
};

/**
 * Reads one snapshot.
 *
 * Mounted above `/admin` in the API router so it is charged against
 * `metricsPollLimiter` (60/min) rather than `adminSessionLimiter` (20/min) — a
 * five-second poll is twelve a minute and would otherwise starve the roster.
 *
 * @returns The snapshot, or `null` if the response carried nothing usable.
 */
export const snapshot = async (): Promise<MetricsSnapshot | null> => {
  const res = await request<Envelope<MetricsSnapshot>>(
    '/api/v1/admin/metrics/snapshot',
  );

  return res.data ?? null;
};
