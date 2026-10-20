import { env } from '../../config/env.ts';
import { readTicketLimitOverview } from '../admin/admin.ticket-limit.service.ts';
import { checkinOpensAt } from '../checkin/checkin.window.ts';
import { readSurveyOverview } from '../survey/survey.admin.ts';
import { latestAlert } from '../../shared/telemetry/alerts.ts';
import {
  readFanout,
  readLatency,
  readLimiters,
  readSeries,
} from '../../shared/telemetry/counters.ts';
import { probeDependencies } from '../../shared/telemetry/probes.ts';
import { logger } from '../../shared/logger/logger.ts';

import {
  checkinTotals,
  checkinTotalsByPrefix,
  redemptionTotals,
  topErrors,
} from './metrics.repository.ts';

import type { LimiterGauge, Series } from '../../shared/telemetry/counters.ts';
import type {
  CheckinPrefixTotal,
  RedemptionTotal,
  TopError,
} from './metrics.repository.ts';
import type { SurveyOverview } from '../../types/survey.ts';
import type { TicketLimitOverview } from '../../types/ticket-limit.ts';

/** Counters the panel graphs, read as a sixty-minute series. */
const SERIES_NAMES = [
  'http.req',
  // Door traffic only. The door-stalled rule fires on this, and a number an
  // alert fires on should be one an operator can look at.
  'checkin.req',
  'http.4xx',
  'http.429',
  'http.5xx',
  'http.shed',
  'checkin.complete',
  'redeem.redeemed',
  'redeem.duplicate',
  'redeem.not_entitled',
  'admin.login.blocked',
  'client.error',
  'telemetry.dropped',
  // Not the same population as `http.5xx`. A 500 is a response; this is what
  // `recordEvent` counted, which includes failures that never became one.
  'severity.error',
] as const;

/**
 * Surfaces the latency panel reports on, as histogram groups.
 *
 * These were route prefixes read straight back as histogram keys, which never
 * matched: nothing requests `/api/v1/checkin` itself, so the two API rows read
 * `—` permanently while the measurements sat under `/api/v1/checkin/ticket` and
 * its siblings. `observeLatency` now files by group, and this names the groups.
 *
 * The panel shows each group by name, from `admin-metrics.latency.*`, because
 * "Check-in API" is what an operator is actually asking about and
 * `api.checkin` is an implementation detail.
 */
export const LATENCY_GROUPS = [
  'checkin',
  'api.checkin',
  'staff',
  'api.staff',
] as const;

/** One surface on the latency panel. */
export type LatencyGroup = (typeof LATENCY_GROUPS)[number];

const SERIES_MINUTES = 60;

/** When each audience's check-in window opens, and whether it has. */
export interface WindowState {
  role: string;
  opensAt: string | null;
  open: boolean;
}

/** Everything one dashboard poll needs. */
export interface MetricsSnapshot {
  generatedAt: string;
  release: string;
  uptimeSeconds: number;
  windows: WindowState[];
  lastAlert: ReturnType<typeof latestAlert>;
  series: Series;
  limiters: LimiterGauge[];
  fanout: { ip: string; sessions: number }[];
  latency: Record<
    string,
    { p50: number | null; p95: number | null; count: number }
  >;
  health: Awaited<ReturnType<typeof probeDependencies>>;
  topErrors: TopError[];
  redemptions: RedemptionTotal[];
  checkins: { attendeeRole: string; checkedIn: number; expected: number }[];

  /** Participant check-ins by ticket prefix, in display order. */
  checkinPrefixes: CheckinPrefixTotal[];

  /** `null` when the read failed; the panel then hides the block. */
  ticketLimit: TicketLimitOverview | null;

  /**
   * The questionnaire's totals. `null` when the administrator may not see them
   * (see {@link SnapshotOptions.survey}) or when the read failed. Counts only:
   * the questionnaire stores a date and no time, so there is no series to draw.
   */
  survey: SurveyOverview | null;
}

/** What a snapshot includes beyond what every `metrics:read` holder sees. */
export interface SnapshotOptions {
  /**
   * Include the questionnaire's totals. Those are gated by `export:read`, so
   * the caller passes whether this administrator holds it.
   */
  survey: boolean;
}

/**
 * Degrades a failed read to a fallback rather than failing the snapshot.
 *
 * The panel is most worth looking at when something is broken, so one dead
 * store must not blank the screen. A Redis outage should leave the Postgres
 * panels populated and the Redis ones empty, which is itself the diagnosis.
 *
 * @param label - What was being read, for the log line.
 * @param read - The read to attempt.
 * @param fallback - What the panel shows if it fails.
 */
const settle = async <T>(
  label: string,
  read: Promise<T>,
  fallback: T,
): Promise<T> => {
  try {
    return await read;
  } catch (err) {
    logger.debug({ err, panel: label }, 'Metrics panel unavailable');

    return fallback;
  }
};

/**
 * Builds one dashboard snapshot.
 *
 * Every panel is read concurrently and independently: the endpoint answers 200
 * with holes rather than 500 with nothing, because "which half is down" is the
 * question being asked of it.
 *
 * @param options - Which scope-gated panels to include.
 * @returns The snapshot the panel renders.
 */
export const buildSnapshot = async (
  options: SnapshotOptions,
): Promise<MetricsSnapshot> => {
  const limiters = await settle('limiters', readLimiters(1), []);

  // Only the addresses a limiter is already tracking. Scanning the keyspace for
  // `f:*` would be the obvious way to find them and is the wrong one on a
  // five-second poll.
  const ips = [
    ...new Set(
      limiters
        .filter((limiter) => limiter.name.includes('ip'))
        .flatMap((limiter) => limiter.topKeys.map((entry) => entry.key)),
    ),
  ];

  const [
    series,
    fanout,
    latencies,
    health,
    errors,
    redemptions,
    checkins,
    checkinPrefixes,
    ticketLimit,
    survey,
  ] = await Promise.all([
    settle('series', readSeries(SERIES_NAMES, SERIES_MINUTES), {}),
    settle('fanout', readFanout(ips), []),
    settle(
      'latency',
      Promise.all(LATENCY_GROUPS.map((group) => readLatency(group))),
      LATENCY_GROUPS.map(() => ({ p50: null, p95: null, count: 0 })),
    ),
    settle('health', probeDependencies(), {
      redis: { ok: false, durationMs: 0, error: 'unavailable' },
      postgres: { ok: false, durationMs: 0, error: 'unavailable' },
    }),
    settle('topErrors', topErrors(), []),
    settle('redemptions', redemptionTotals(), []),
    settle('checkins', checkinTotals(), []),
    settle('checkinPrefixes', checkinTotalsByPrefix(), []),
    settle('ticketLimit', readTicketLimitOverview(), null),
    options.survey ? settle('survey', readSurveyOverview(), null) : null,
  ]);

  return {
    generatedAt: new Date().toISOString(),
    release: env.releaseId,
    uptimeSeconds: Math.round(process.uptime()),

    // `checkinOpensAt`, not `isCheckinOpen` — the latter takes a `Request` so it
    // can honour the landing bypass cookie, and there is none here. `null` means
    // there is no curtain at all, which reads as open. Same call and same
    // reasoning as the door-stalled rule in `rules.ts`.
    windows: (['participant', 'volunteer'] as const).map((role) => {
      const opensAt = checkinOpensAt(role);

      return {
        role,
        opensAt: opensAt === null ? null : new Date(opensAt).toISOString(),
        open: opensAt === null || Date.now() >= opensAt,
      };
    }),

    lastAlert: latestAlert(),
    series,
    limiters,
    fanout,
    latency: Object.fromEntries(
      LATENCY_GROUPS.map((group, index) => [
        group,
        latencies[index] ?? { p50: null, p95: null, count: 0 },
      ]),
    ),
    health,
    topErrors: errors,
    redemptions,
    checkins,
    checkinPrefixes,
    ticketLimit,
    survey,
  };
};
