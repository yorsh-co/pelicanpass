import redis from '../db/redis.ts';
import { logger } from '../logger/logger.ts';

import { bump } from './window.ts';

import type { LimiterKeyBasis, LimiterPurpose } from '../../types/limiter.ts';

/**
 * Redis-backed counters, histograms and limiter gauges for the dashboard.
 *
 * **This is not a duplicate of `window.ts`, and the two must not be merged.**
 * The in-memory ring serves the alert loop, which has to keep working through
 * exactly the Redis outage it needs to report; these keys serve the dashboard,
 * which needs sixty minutes of history that survives a container recreate. One
 * wants availability, the other durability. {@link count} writes both from a
 * single call so they cannot drift.
 *
 * Everything here is lossy by design. A dropped datapoint is a gap in a graph;
 * a failed check-in is somebody standing at a door.
 */

/** How long a minute bucket lives. Sixty of them are one dashboard window. */
const BUCKET_TTL_SECONDS = 3_600;

/** Sorted sets and HyperLogLogs cover a five-minute window. */
const WINDOW_TTL_SECONDS = 300;

/** Most keys kept per limiter in the busiest-keys set. */
const TOP_KEYS_KEPT = 20;

/**
 * Buffered writes are flushed on this interval.
 *
 * The plan said one pipeline per request. Buffering is strictly better and is
 * the one deliberate deviation: at the door a per-request pipeline is a round
 * trip per request on top of the limiter's own, while this aggregates a second
 * of traffic into a single pipeline — a hundred increments to one `INCRBY`.
 * The cost is up to one second of counters on an abrupt exit, which is the
 * cheap direction to fail for a graph.
 */
const FLUSH_INTERVAL_MS = 1_000;

/** Latency histogram edges, in milliseconds. */
const LATENCY_BUCKETS = [50, 100, 250, 500, 1_000, 2_500] as const;

const pendingIncr = new Map<string, number>();
const pendingMax = new Map<string, number>();
const pendingZincr = new Map<string, Map<string, number>>();
const pendingPf = new Map<string, Set<string>>();

/** What the panel knows about a limiter before any traffic reaches it. */
export interface LimiterMeta {
  readonly ceiling: number;
  readonly duration: number;
  /** What one bucket covers, for the row's badge. */
  readonly basis: string;
  readonly keyedOn: LimiterKeyBasis;
  readonly protects: LimiterPurpose;
  readonly tier?: 'strict' | 'trusted' | undefined;
}

/**
 * Every limiter, declared at boot rather than discovered from traffic.
 *
 * Two things changed here at once, and the second is why the first became
 * possible. The panel used to learn a limiter existed only when one was
 * consumed, so a missing row meant either "no traffic yet" or "the
 * instrumentation is broken" — indistinguishable, and least distinguishable
 * before the doors opened.
 *
 * And the ceiling used to be inferred from `consumedPoints + remainingPoints`,
 * because the tiered limiters hid two quotas behind one prefix and the
 * definition could not say which applied. That inference had its own failure:
 * on a refusal `remainingPoints` is 0 while `consumedPoints` climbs past the
 * quota, so the ceiling tracked the overage. Splitting the tiers into their own
 * limiters removed the ambiguity that forced the inference, so the definition
 * is authoritative again and that whole class of bug is gone rather than
 * guarded against.
 */
const limiterMeta = new Map<string, LimiterMeta>();

/** Limiters known to the panel. Seeded at boot; never grows from traffic. */
const knownLimiters = new Set<string>();

let flushTimer: NodeJS.Timeout | null = null;

/** `yyyymmddHHMM` for a minute bucket. */
const minuteKey = (at = Date.now()): string =>
  new Date(at).toISOString().slice(0, 16).replace(/[-:T]/g, '');

/** `yyyymmddHHMM` rounded down to a five-minute boundary. */
const windowKey = (at = Date.now()): string =>
  minuteKey(Math.floor(at / (5 * 60_000)) * 5 * 60_000);

const addIncr = (key: string, by: number): void => {
  pendingIncr.set(key, (pendingIncr.get(key) ?? 0) + by);
};

const addMax = (key: string, value: number): void => {
  const current = pendingMax.get(key);

  if (current === undefined || value > current) pendingMax.set(key, value);
};

const addZincr = (key: string, member: string, by: number): void => {
  const members = pendingZincr.get(key) ?? new Map<string, number>();

  members.set(member, (members.get(member) ?? 0) + by);
  pendingZincr.set(key, members);
};

const addPf = (key: string, member: string): void => {
  const members = pendingPf.get(key) ?? new Set<string>();

  members.add(member);
  pendingPf.set(key, members);
};

/**
 * Counts one occurrence, in both sinks.
 *
 * Replaces the direct `bump` at every call site: one call, two destinations,
 * no chance of a name existing in one and not the other.
 *
 * @param name - Counter name, e.g. `http.5xx`.
 * @param by - How much to add.
 */
export const count = (name: string, by = 1): void => {
  bump(name, by);
  addIncr(`m:${name}:${minuteKey()}`, by);
};

/**
 * Surfaces the latency histogram is kept for, longest prefix first.
 *
 * A **fixed** list, and that is the point twice over.
 *
 * Keys used to be the exact normalised route, which broke the panel in both
 * directions. Nothing ever requests `/api/v1/checkin` itself — the real paths
 * are `/api/v1/checkin/ticket` and `/api/v1/checkin/verification` — so the API
 * rows read `—` for ever while the data sat under keys nobody looked at. And
 * every response minted its own key, including static assets, every hashed JS
 * chunk, and any 404 path a scanner cared to invent: an attacker-controlled
 * keyspace, seven buckets a minute each, held for an hour.
 *
 * Grouping at write time fixes both. Eight groups times seven buckets times
 * sixty minutes is a ceiling of 3,360 keys however much traffic arrives.
 *
 * Dotted rather than colon-separated, matching the counter names: `:` is the
 * key's own separator, and a group carrying one makes `h:api:checkin:250:…`
 * ambiguous to anyone splitting it back apart.
 */
const LATENCY_GROUPS: readonly (readonly [string, string])[] = [
  ['/api/v1/checkin', 'api.checkin'],
  ['/api/v1/staff', 'api.staff'],
  ['/api/v1/admin', 'api.admin'],
  ['/api/v1/attendee', 'api.attendee'],
  ['/checkin', 'checkin'],
  ['/staff', 'staff'],
  ['/admin', 'admin'],
];

/** Served by `express.static` or by a probe: not the application's latency. */
const UNMEASURED = ['/css/', '/js/', '/assets/'];

/**
 * Which histogram a route belongs to, or `null` if it is not worth measuring.
 *
 * @param route - Normalised route, from `normaliseRoute`.
 */
const latencyGroup = (route: string): string | null => {
  if (UNMEASURED.some((prefix) => route.startsWith(prefix))) return null;

  // Probes run on timers and would dominate a percentile with the one number
  // nobody is asking about.
  if (route === '/healthz' || route === '/readyz') return null;

  for (const [prefix, group] of LATENCY_GROUPS) {
    if (route.startsWith(prefix)) return group;
  }

  // One bucket for everything else, so an unlisted route is still counted
  // without being able to mint a key of its own.
  return 'other';
};

/**
 * Files a request's duration into the histogram for its surface.
 *
 * Bucketed rather than stored per request, so p50 and p95 are computed on read
 * and two windows merge by adding their buckets. `+Inf` is a real bucket: a
 * request slower than the largest edge still has to be counted somewhere, and
 * a histogram that silently drops its tail is worse than no histogram.
 *
 * @param route - Normalised route, from `normaliseRoute`.
 * @param durationMs - Wall time from first byte in to response finished.
 */
export const observeLatency = (route: string, durationMs: number): void => {
  const group = latencyGroup(route);

  if (group === null) return;

  const edge = LATENCY_BUCKETS.find((bucket) => durationMs <= bucket);
  const label = edge === undefined ? 'inf' : String(edge);

  addIncr(`h:${group}:${label}:${minuteKey()}`, 1);
};

/**
 * Records what a limiter consume cost, refused or not.
 *
 * Called from `createLimiterMiddleware` **and** from the four failure budgets
 * that are consumed from services rather than mounted as middleware. Those
 * four are the ones an abuse panel is actually read for, and instrumenting the
 * middleware alone would produce a panel that looks complete without them.
 *
 * `remainingPoints` used to be a parameter, to derive the ceiling. It is gone:
 * the registry holds the quota now, so the only thing the result still carries
 * that nothing else knows is how much has been spent.
 *
 * @param name - The limiter's key prefix.
 * @param key - What it keyed on, in the form the panel may show: an IP or a
 *   global key verbatim, anything else as a digest prefix (`panelKey`).
 * @param consumedPoints - Points spent in the current window.
 * @param refused - Whether this consume was the one that went over.
 */
export const recordLimiterResult = (
  name: string,
  key: string,
  consumedPoints: number,
  refused: boolean,
): void => {
  // The ceiling is deliberately not touched here — it comes from the registry,
  // so a limiter being hammered past its quota can no longer talk its own
  // ceiling upward.
  //
  // The name is still added, as a backstop rather than as the mechanism: a
  // limiter that somehow escaped the registry should appear on the panel
  // unexplained rather than not appear at all. Its row will show a null ceiling,
  // which reads as "this exists and nobody described it" — the right complaint.
  knownLimiters.add(name);

  const minute = minuteKey();

  addIncr(`m:limiter.${name}.consumed:${minute}`, 1);
  if (refused) addIncr(`m:limiter.${name}.refused:${minute}`, 1);

  addMax(`m:limiter.${name}.peak:${minute}`, consumedPoints);
  addZincr(`z:limiter.${name}.topkeys:${windowKey()}`, key, 1);
};

/**
 * Records that an address was seen carrying a particular session.
 *
 * A HyperLogLog rather than a set: the cardinality is the whole question and
 * ~12 bytes an address is what makes it affordable to keep one per IP.
 *
 * This is the CGNAT discriminator. Volume alone cannot tell a carrier NAT from
 * an attacker — both look like one address making a great many requests. Fan-out
 * separates them: a NAT carries hundreds of distinct sessions, an attacker
 * usually carries one.
 *
 * @param ip - The address, as Express resolved it.
 * @param sessionId - Any session id seen on the request.
 */
export const observeFanout = (ip: string, sessionId: string): void => {
  addPf(`f:${ip}:${windowKey()}`, sessionId);
};

/**
 * Writes everything buffered since the last flush.
 *
 * Every command is issued inside one pipeline and the whole thing is caught.
 * That `catch` is load-bearing rather than defensive: `redis.ts` sets
 * `enableOfflineQueue: false`, so a command issued while Redis is down rejects
 * rather than queueing, and `server.ts` turns an unhandled rejection into
 * `die()`. Without this the metrics would kill the process during exactly the
 * outage they exist to report.
 */
const flush = async (): Promise<void> => {
  if (
    pendingIncr.size === 0 &&
    pendingMax.size === 0 &&
    pendingZincr.size === 0 &&
    pendingPf.size === 0
  ) {
    return;
  }

  const incr = [...pendingIncr];
  const max = [...pendingMax];
  const zincr = [...pendingZincr];
  const pf = [...pendingPf];

  pendingIncr.clear();
  pendingMax.clear();
  pendingZincr.clear();
  pendingPf.clear();

  try {
    const pipeline = redis.pipeline();

    for (const [key, by] of incr) {
      pipeline.incrby(key, by);
      pipeline.expire(key, BUCKET_TTL_SECONDS);
    }

    // Plain SET rather than a compare-and-set. This process is the only writer
    // — server.ts runs unclustered, which the limiters' memory tier already
    // relies on — and the buffered value is the maximum seen this minute, so a
    // later flush can only carry a larger one.
    for (const [key, value] of max) {
      pipeline.set(key, String(value));
      pipeline.expire(key, BUCKET_TTL_SECONDS);
    }

    for (const [key, members] of zincr) {
      for (const [member, by] of members) pipeline.zincrby(key, by, member);

      // Trimmed on write rather than on read: an IP-keyed set behind a carrier
      // NAT would otherwise grow a member per address for the whole window.
      pipeline.zremrangebyrank(key, 0, -(TOP_KEYS_KEPT + 1));
      pipeline.expire(key, WINDOW_TTL_SECONDS);
    }

    for (const [key, members] of pf) {
      pipeline.pfadd(key, ...members);
      pipeline.expire(key, WINDOW_TTL_SECONDS);
    }

    await pipeline.exec();
  } catch (err) {
    // Dropped, not requeued. These are graph points, and a backlog written
    // late lands in the wrong minute bucket, which is worse than a gap.
    logger.debug({ err }, 'Metrics flush failed');
  }
};

/**
 * Starts the flush timer.
 *
 * @returns A function that stops it, for the shutdown path.
 */
export const startCounters = (): (() => void) => {
  if (flushTimer) return () => undefined;

  flushTimer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);

  flushTimer.unref();

  return () => {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
  };
};

/** Writes anything buffered, for the shutdown path. */
export const flushCounters = (): Promise<void> => flush();

/**
 * Declares the limiters the panel should show, before any traffic arrives.
 *
 * Called once at boot from `server.ts` with `limiterRegistry()`. It is passed
 * in rather than imported so that `counters.ts` does not depend on
 * `rate.middleware.ts`, which already depends on this module.
 *
 * @param infos - Every limiter, from the middleware's own registry.
 */
export const seedLimiters = (
  infos: readonly (LimiterMeta & { prefix: string })[],
): void => {
  for (const info of infos) {
    limiterMeta.set(info.prefix, info);
    knownLimiters.add(info.prefix);
  }
};

/** Every limiter known to the panel. */
export const limiterNames = (): string[] => [...knownLimiters].sort();

/** The last `minutes` minute-keys, oldest first. */
const recentMinutes = (minutes: number): string[] => {
  const now = Date.now();

  return Array.from({ length: minutes }, (_unused, index) =>
    minuteKey(now - (minutes - 1 - index) * 60_000),
  );
};

/** One counter's per-minute values, oldest first. */
export type Series = Record<string, number[]>;

/** What one limiter looks like on the panel. */
export interface LimiterGauge {
  readonly name: string;
  readonly ceiling: number | null;
  readonly peak: number;
  readonly consumed: number;
  readonly refused: number;
  readonly topKeys: { key: string; points: number }[];
  /** Seconds the quota is measured over, for the tooltip's wording. */
  readonly duration: number | null;
  readonly basis: string | null;
  readonly keyedOn: LimiterKeyBasis | null;
  readonly protects: LimiterPurpose | null;
  readonly tier: 'strict' | 'trusted' | null;
}

/**
 * Reads every counter's window in **one** round trip.
 *
 * One `MGET` over names × minutes rather than one per name. Twenty names over
 * an hour is 1,200 keys, which is a single command; the same read issued per
 * name would be twenty round trips on a five-second poll.
 *
 * A missing key is a minute with no traffic, which reads as 0 rather than as an
 * error — the common case at the start of an hour.
 *
 * @param names - Counter names to read.
 * @param minutes - How many minutes back.
 * @returns Per-name arrays, oldest minute first.
 */
export const readSeries = async (
  names: readonly string[],
  minutes: number,
): Promise<Series> => {
  const buckets = recentMinutes(minutes);
  const keys = names.flatMap((name) =>
    buckets.map((bucket) => `m:${name}:${bucket}`),
  );

  if (keys.length === 0) return {};

  const values = await redis.mget(...keys);

  const series: Series = {};

  names.forEach((name, index) => {
    const slice = values.slice(index * minutes, (index + 1) * minutes);

    series[name] = slice.map((value) => Number(value ?? 0));
  });

  return series;
};

/**
 * Reads the limiter panel: consumption, refusals, peak and busiest keys.
 *
 * `peak` and the counters are read for the current minute, because the question
 * the panel answers is "how close are we right now". The busiest keys come from
 * the five-minute window, which is long enough for a pattern to show and short
 * enough to still be about now.
 *
 * @param minutes - Window for the consumed and refused totals.
 * @returns One gauge per limiter seen since boot.
 */
export const readLimiters = async (minutes = 1): Promise<LimiterGauge[]> => {
  const names = limiterNames();

  if (names.length === 0) return [];

  const [consumed, refused, peaks] = await Promise.all([
    readSeries(
      names.map((name) => `limiter.${name}.consumed`),
      minutes,
    ),
    readSeries(
      names.map((name) => `limiter.${name}.refused`),
      minutes,
    ),
    redis.mget(...names.map((name) => `m:limiter.${name}.peak:${minuteKey()}`)),
  ]);

  const window = windowKey();

  const topKeys = await Promise.all(
    names.map((name) =>
      redis.zrevrange(
        `z:limiter.${name}.topkeys:${window}`,
        0,
        TOP_KEYS_KEPT - 1,
        'WITHSCORES',
      ),
    ),
  );

  const sum = (values: number[] | undefined): number =>
    (values ?? []).reduce((total, value) => total + value, 0);

  return names.map((name, index) => {
    const flat = topKeys[index] ?? [];
    const pairs: { key: string; points: number }[] = [];

    for (let i = 0; i < flat.length; i += 2) {
      pairs.push({ key: flat[i] ?? '', points: Number(flat[i + 1] ?? 0) });
    }

    const meta = limiterMeta.get(name);

    return {
      name,
      ceiling: meta?.ceiling ?? null,
      peak: Number(peaks[index] ?? 0),
      consumed: sum(consumed[`limiter.${name}.consumed`]),
      refused: sum(refused[`limiter.${name}.refused`]),
      topKeys: pairs,
      duration: meta?.duration ?? null,
      basis: meta?.basis ?? null,
      keyedOn: meta?.keyedOn ?? null,
      protects: meta?.protects ?? null,
      tier: meta?.tier ?? null,
    };
  });
};

/**
 * Approximate distinct sessions seen per address in the current window.
 *
 * Reads only the addresses currently in a limiter's busiest-keys set, so this
 * costs a `PFCOUNT` per interesting address rather than a scan of the keyspace.
 * `SCAN` over `f:*` would be the obvious implementation and is the wrong one:
 * it walks every key in the database on a five-second poll.
 *
 * @param ips - Addresses to count, normally from {@link readLimiters}.
 * @returns Fan-out per address, highest first.
 */
export const readFanout = async (
  ips: readonly string[],
): Promise<{ ip: string; sessions: number }[]> => {
  if (ips.length === 0) return [];

  const window = windowKey();
  const counts = await Promise.all(
    ips.map((ip) => redis.pfcount(`f:${ip}:${window}`)),
  );

  return ips
    .map((ip, index) => ({ ip, sessions: counts[index] ?? 0 }))
    .sort((a, b) => b.sessions - a.sessions);
};

/**
 * Percentiles for one route, computed from its histogram buckets.
 *
 * Returns the bucket edge the percentile falls in, not an interpolated value —
 * "p95 is at or under 250 ms" is what a bucketed histogram can honestly say,
 * and inventing a number between edges would be precision the data does not
 * have.
 *
 * @param group - Histogram group, from {@link LATENCY_GROUPS}.
 * @param minutes - How many minutes back.
 * @returns p50 and p95 as bucket edges, or null where there is no traffic.
 */
export const readLatency = async (
  group: string,
  minutes = 15,
): Promise<{ p50: number | null; p95: number | null; count: number }> => {
  const buckets = recentMinutes(minutes);
  const labels = [...LATENCY_BUCKETS.map(String), 'inf'];

  const keys = labels.flatMap((label) =>
    buckets.map((bucket) => `h:${group}:${label}:${bucket}`),
  );

  const values = await redis.mget(...keys);

  const perLabel = labels.map((_label, index) =>
    values
      .slice(index * minutes, (index + 1) * minutes)
      .reduce((total, value) => total + Number(value ?? 0), 0),
  );

  const total = perLabel.reduce((sum, value) => sum + value, 0);

  if (total === 0) return { p50: null, p95: null, count: 0 };

  const edgeAt = (fraction: number): number | null => {
    let seen = 0;

    for (const [index, value] of perLabel.entries()) {
      seen += value;

      if (seen >= total * fraction) {
        return LATENCY_BUCKETS[index] ?? null;
      }
    }

    return null;
  };

  return { p50: edgeAt(0.5), p95: edgeAt(0.95), count: total };
};

export { LATENCY_BUCKETS, minuteKey, windowKey };
