/**
 * Reduces the app's request log to an anonymous traffic summary: how hard
 * each per-IP limiter was pressed, how requests spread over client addresses,
 * and how often entries failed. The output carries counts, minutes and
 * normalised paths only: no address, user agent, query string or path token.
 *
 * What it answers is what docs/performance/load-testing.md calibrates the load test
 * against, and what the container's stdout alone records: the `warn`+ log
 * file keeps no successful request.
 */

import { isIP } from 'node:net';

import { DEFAULT_RATE_LIMITS } from '../../src/config/rate-limits.ts';

/** One completed request, as the HTTP logger writes it. */
export interface RequestLine {
  /** Epoch milliseconds. */
  time: number;
  method: string;
  /** Path without the query string. */
  path: string;
  ip: string;
  status: number;
}

/** The per-IP limiters a request is charged to (docs/performance/rate-limiting.md). */
export type Group = 'api' | 'web' | 'checkin-entry';

export const GROUPS: readonly Group[] = ['api', 'web', 'checkin-entry'];

/** Strict per-IP quota per minute, the tier every untrusted address gets. */
export const STRICT_PER_MINUTE: Readonly<Record<Group, number>> = {
  api: DEFAULT_RATE_LIMITS['rl:ip'].points,
  web: DEFAULT_RATE_LIMITS['rl:ip:web'].points,
  'checkin-entry': DEFAULT_RATE_LIMITS['rl:ip:checkin-entry'].points,
};

/** The global entry-failure budget per minute. */
export const ENTRY_FAILURE_BUDGET =
  DEFAULT_RATE_LIMITS['rl:global:checkin-entry-failures'].points;

/** Served by `express.static` ahead of every router and limiter. */
const STATIC = /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/;

const PROBES = new Set(['/healthz', '/readyz']);

/** Exempt from `rl:ip` once the session resolves (`IP_LIMIT_EXEMPT`). */
const API_IP_EXEMPT = new Set([
  '/api/v1/attendee/pass',
  '/api/v1/attendee/status',
  '/api/v1/survey',
]);

const WEBHOOK_PREFIX = '/api/v1/whatsapp/webhook/';

/** Lookups whose failure spends the global entry-failure budget. */
const ENTRY_LOOKUPS = new Set(['/api/v1/checkin/ticket', '/api/v1/checkin/qr']);

const VERIFICATION = '/api/v1/checkin/verification';

/** Rows kept in the address-share and route tables. */
const TOP = 10;

/**
 * Reads one log line, or `null` for anything that is not a completed request.
 *
 * @param line - One line of `docker compose logs app --no-log-prefix`.
 */
export const parseLine = (line: string): RequestLine | null => {
  let record: unknown;

  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof record !== 'object' || record === null) return null;

  const { msg, time, ip, req, res } = record as Record<string, unknown>;
  const request = (req ?? {}) as Record<string, unknown>;
  const response = (res ?? {}) as Record<string, unknown>;

  if (
    msg !== 'request completed' ||
    typeof time !== 'number' ||
    typeof ip !== 'string' ||
    typeof request.method !== 'string' ||
    typeof request.url !== 'string' ||
    typeof response.statusCode !== 'number'
  ) {
    return null;
  }

  return {
    time,
    method: request.method,
    path: request.url.split('?')[0] ?? '',
    ip: ip.startsWith('::ffff:') ? ip.slice(7) : ip,
    status: response.statusCode,
  };
};

/**
 * The per-IP limiters a request is charged to.
 *
 * @param request - The request.
 */
export const groupsOf = (request: RequestLine): Group[] => {
  const { method, path } = request;

  if (PROBES.has(path) || STATIC.test(path)) return [];

  if (path.startsWith('/api/')) {
    return API_IP_EXEMPT.has(path) || path.startsWith(WEBHOOK_PREFIX)
      ? []
      : ['api'];
  }

  return method === 'GET' && path === '/checkin'
    ? ['web', 'checkin-entry']
    : ['web'];
};

/**
 * A path with its identifiers and tokens masked, so the route table names
 * routes rather than records.
 *
 * @param path - Path without the query string.
 */
export const normalisePath = (path: string): string =>
  path
    .split('/')
    .map((segment) =>
      /^[0-9a-f-]{16,}$/i.test(segment) ||
      /^[A-Za-z0-9_-]{16,}$/.test(segment) ||
      /^\d{3,}$/.test(segment)
        ? ':id'
        : segment,
    )
    .join('/');

const minuteOf = (time: number): string =>
  new Date(time).toISOString().slice(0, 16);

const increment = <K>(map: Map<K, number>, key: K, by = 1) => {
  map.set(key, (map.get(key) ?? 0) + by);
};

const peak = (map: ReadonlyMap<unknown, number>): number =>
  Math.max(0, ...map.values());

const topValues = (map: ReadonlyMap<unknown, number>, n: number): number[] =>
  [...map.values()].sort((a, b) => b - a).slice(0, n);

export interface GroupSummary {
  requests: number;
  /** The strict per-minute quota the peaks compare against. */
  strict: number;
  /** Most requests one address made in one minute. */
  peakPerAddressMinute: number;
  /** The five highest per-address minutes, highest first. */
  topPerAddressMinute: number[];
  /** Address-minutes over the strict quota. */
  overStrict: number;
  /** Most requests in one minute, all addresses together. */
  peakMinute: number;
}

export interface TrafficSummary {
  from: string | null;
  to: string | null;
  lines: number;
  requests: number;
  addresses: {
    total: number;
    v4: number;
    v6: number;
    /** Share of requests from IPv6 addresses. */
    v6RequestShare: number;
    /** The highest shares of all requests one address carried. */
    topShares: number[];
  };
  groups: Record<Group, GroupSummary>;
  /** Requests answered `429`. */
  refused: number;
  /** Requests answered `503`: shed, or a failure. */
  unavailable: number;
  entryFailures: { total: number; peakPerMinute: number; budget: number };
  verificationFailures: { total: number; peakPerMinute: number };
  busiestMinute: { minute: string; requests: number } | null;
  routes: [string, number][];
}

/**
 * A running tally over log lines, fed one at a time so a large log never has
 * to be held in memory.
 */
export const createTally = () => {
  let lines = 0;
  let requests = 0;
  let first: number | null = null;
  let last: number | null = null;
  let refused = 0;
  let unavailable = 0;

  const perAddress = new Map<string, number>();
  const perMinute = new Map<string, number>();
  const routes = new Map<string, number>();
  const byGroup = (): Record<Group, Map<string, number>> => ({
    api: new Map(),
    web: new Map(),
    'checkin-entry': new Map(),
  });
  /** Requests per `address minute`, per limiter. */
  const cells = byGroup();
  /** Requests per minute, all addresses, per limiter. */
  const minutes = byGroup();
  const totals = new Map<Group, number>();
  const entryFailures = new Map<string, number>();
  const verificationFailures = new Map<string, number>();

  return {
    /**
     * Counts one line; anything but a completed request is skipped.
     *
     * @param line - One log line.
     */
    add(line: string): void {
      lines++;

      const request = parseLine(line);

      if (!request) return;

      const minute = minuteOf(request.time);

      requests++;
      first = first === null ? request.time : Math.min(first, request.time);
      last = last === null ? request.time : Math.max(last, request.time);

      increment(perAddress, request.ip);
      increment(perMinute, minute);
      increment(routes, `${request.method} ${normalisePath(request.path)}`);

      if (request.status === 429) refused++;
      if (request.status === 503) unavailable++;

      for (const group of groupsOf(request)) {
        increment(totals, group);
        increment(cells[group], `${request.ip} ${minute}`);
        increment(minutes[group], minute);
      }

      const failed =
        request.method === 'POST' &&
        request.status >= 400 &&
        request.status < 500 &&
        request.status !== 429;

      if (failed && ENTRY_LOOKUPS.has(request.path)) {
        increment(entryFailures, minute);
      }

      if (failed && request.path === VERIFICATION) {
        increment(verificationFailures, minute);
      }
    },

    /** The summary of every line added so far. */
    result(): TrafficSummary {
      const families = [...perAddress.entries()].map(([ip, n]) => ({
        v6: isIP(ip) === 6,
        n,
      }));
      const v6Requests = families
        .filter((f) => f.v6)
        .reduce((sum, f) => sum + f.n, 0);
      const busiest = [...perMinute.entries()].sort(
        ([a, x], [b, y]) => y - x || (a < b ? -1 : 1),
      )[0];

      return {
        from: first === null ? null : minuteOf(first),
        to: last === null ? null : minuteOf(last),
        lines,
        requests,
        addresses: {
          total: perAddress.size,
          v4: families.filter((f) => !f.v6).length,
          v6: families.filter((f) => f.v6).length,
          v6RequestShare: requests === 0 ? 0 : v6Requests / requests,
          topShares: topValues(perAddress, TOP).map((n) => n / requests),
        },
        groups: Object.fromEntries(
          GROUPS.map((group) => {
            const groupCells = cells[group];

            return [
              group,
              {
                requests: totals.get(group) ?? 0,
                strict: STRICT_PER_MINUTE[group],
                peakPerAddressMinute: peak(groupCells),
                topPerAddressMinute: topValues(groupCells, 5),
                overStrict: [...groupCells.values()].filter(
                  (n) => n > STRICT_PER_MINUTE[group],
                ).length,
                peakMinute: peak(minutes[group]),
              },
            ];
          }),
        ) as Record<Group, GroupSummary>,
        refused,
        unavailable,
        entryFailures: {
          total: [...entryFailures.values()].reduce((a, b) => a + b, 0),
          peakPerMinute: peak(entryFailures),
          budget: ENTRY_FAILURE_BUDGET,
        },
        verificationFailures: {
          total: [...verificationFailures.values()].reduce((a, b) => a + b, 0),
          peakPerMinute: peak(verificationFailures),
        },
        busiestMinute: busiest
          ? { minute: busiest[0], requests: busiest[1] }
          : null,
        routes: [...routes.entries()]
          .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
          .slice(0, TOP * 2),
      };
    },
  };
};

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

const count = (n: number) => n.toLocaleString('en-US');

/**
 * Renders a summary as Markdown.
 *
 * @param summary - From {@link createTally}.
 */
export const renderSummary = (summary: TrafficSummary): string => {
  const { addresses, groups } = summary;
  const rows = (cells: readonly (readonly string[])[]) =>
    cells.map((c) => `| ${c.join(' | ')} |`).join('\n');

  return `${[
    '# Traffic summary',
    'Generated by `scripts/telemetry/traffic-summary.ts` from the request log of the app container. It holds counts, ' +
      'minutes and normalised paths only: no address, user agent, query string or path token. Minutes are UTC.',
    `${summary.from ?? '—'} to ${summary.to ?? '—'}: ${count(summary.requests)} requests in ${count(summary.lines)} log lines. ` +
      `${count(summary.refused)} answered 429, ${count(summary.unavailable)} answered 503.` +
      (summary.busiestMinute
        ? ` Busiest minute ${summary.busiestMinute.minute}, ${count(summary.busiestMinute.requests)} requests.`
        : ''),
    '## Client addresses',
    `${count(addresses.total)} addresses: ${count(addresses.v4)} IPv4, ${count(addresses.v6)} IPv6, which carried ` +
      `${pct(addresses.v6RequestShare)} of requests. The biggest shares of all requests one address carried: ` +
      `${addresses.topShares.map(pct).join(', ') || '—'}.`,
    '## Per-IP limiters',
    'Per address and minute, against the strict quota an untrusted address gets. Trusted addresses have ten ' +
      'times that; the summary cannot tell which addresses were trusted. Minutes are calendar minutes, which ' +
      'approximate the windows the limiters keep.',
    [
      '| Limiter | Requests | Strict quota | Peak address-minute | Next highest | Over quota | Peak minute, all addresses |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      rows(
        GROUPS.map((group) => {
          const g = groups[group];

          return [
            {
              api: '`rl:ip`',
              web: '`rl:ip:web`',
              'checkin-entry': '`rl:ip:checkin-entry`',
            }[group],
            count(g.requests),
            `${String(g.strict)}/min`,
            count(g.peakPerAddressMinute),
            g.topPerAddressMinute.slice(1).map(count).join(', ') || '—',
            `${count(g.overStrict)} address-minutes`,
            count(g.peakMinute),
          ];
        }),
      ),
    ].join('\n'),
    '## Entry failures',
    `Failed ticket and QR lookups, which spend the global budget of ${String(summary.entryFailures.budget)} a minute: ` +
      `${count(summary.entryFailures.total)} in all, at most ${count(summary.entryFailures.peakPerMinute)} in one minute. ` +
      `Wrong verification codes, charged to each attendee instead: ${count(summary.verificationFailures.total)}, at ` +
      `most ${count(summary.verificationFailures.peakPerMinute)} in one minute.`,
    '## Busiest routes',
    [
      '| Route | Requests |',
      '| --- | --- |',
      rows(summary.routes.map(([route, n]) => [`\`${route}\``, count(n)])),
    ].join('\n'),
  ].join('\n\n')}\n`;
};
