import type { DemoLocale } from './locale-route.ts';
import type { MetricsSnapshot } from '../core/api/api.admin.metrics.ts';

const ALERT_TITLE: Record<DemoLocale, string> = {
  'pt-BR': 'Fila de check-in acima do normal',
  en: 'Check-in queue above normal',
};
const ERROR_MESSAGE: Record<DemoLocale, string> = {
  'pt-BR': 'Falha inesperada registrada',
  en: 'Unexpected failure logged',
};

/** The dashboard's poll interval, which is how often the figures move. */
const POLL_MS = 5_000;

/**
 * A small non-negative offset that changes on every poll but repeats for the
 * same instant, so the dashboard looks live without a random source.
 *
 * @param now - Epoch milliseconds of the request.
 * @param salt - Varies the offset between figures.
 */
const wobble = (now: number, salt: number): number =>
  (Math.floor(now / POLL_MS) * 7 + salt * 5) % 4;

/**
 * The figures the metrics dashboard polls for in the demo.
 *
 * They repeat the `admin-metrics-full` view fixture, which is what the page is
 * rendered with, so the first poll confirms the numbers on screen instead of
 * replacing them. The latest check-in and error counts and the latencies move
 * a little with `now`. The fields the fixture leaves out (`consumed`, `lastSeen`
 * and the alert's `severity` and `at`) are filled in plausibly.
 *
 * @param now - Epoch milliseconds the snapshot is stamped with.
 * @param locale - The page's language, which the alert is written in.
 */
export const metricsSnapshot = (
  now: number,
  locale: DemoLocale,
): MetricsSnapshot => ({
  generatedAt: new Date(now).toISOString(),
  release: 'demo',
  uptimeSeconds: 7200,
  windows: [
    {
      role: 'participant',
      opensAt: new Date(now - 1000).toISOString(),
      open: true,
    },
    { role: 'volunteer', opensAt: null, open: true },
  ],
  lastAlert: {
    severity: 'warn',
    title: ALERT_TITLE[locale],
    at: new Date(now - 300_000).toISOString(),
  },
  series: {
    'checkin.complete': [1, 4, 9, 3 + wobble(now, 1)],
    'severity.error': [0, 1, wobble(now, 2) % 2],
  },
  limiters: [
    {
      name: 'checkin-entry-ip',
      tier: 'strict',
      basis: null,
      keyedOn: 'ip',
      protects: 'checkin',
      ceiling: 30,
      duration: 60,
      peak: 27,
      consumed: 27,
      refused: 3,
      topKeys: [{ key: '203.0.113.7', points: 27 }],
    },
  ],
  fanout: [{ ip: '203.0.113.7', sessions: 4 }],
  latency: {
    checkin: { p50: 12 + wobble(now, 3), p95: 40 + wobble(now, 4), count: 10 },
    'api.checkin': {
      p50: 30 + wobble(now, 5),
      p95: 90 + wobble(now, 6),
      count: 8,
    },
    staff: { p50: null, p95: null, count: 0 },
    'api.staff': { p50: 20, p95: 70, count: 5 },
  },
  health: {
    redis: { ok: true, durationMs: 2 },
    postgres: { ok: true, durationMs: 3 },
  },
  topErrors: [
    {
      fingerprint: 'ab12cd34',
      occurrences: 3,
      code: 'INTERNAL_ERROR',
      route: '/api/checkin',
      message: ERROR_MESSAGE[locale],
      lastSeen: new Date(now - 600_000).toISOString(),
    },
  ],
  redemptions: [
    { item: 'tshirt', outcome: 'redeemed', total: 12 },
    { item: 'lunch', outcome: 'redeemed', total: 7 },
  ],
  checkins: [
    { attendeeRole: 'participant', checkedIn: 120, expected: 400 },
    { attendeeRole: 'volunteer', checkedIn: 30, expected: 60 },
  ],
  checkinPrefixes: [{ prefix: 'EV26', checkedIn: 120, expected: 400 }],
  ticketLimit: {
    scope: 'total',
    cap: 500,
    mode: 'hard',
    used: 430,
    remaining: 70,
    status: 'near',
  },
  survey: {
    state: { open: true, reason: 'schedule' },
    override: null,
    opensAt: now - 3_600_000,
    closesAt: now + 3_600_000,
    audiences: {
      participant: { enabled: true, hasQuestions: true, responses: 30 },
      volunteer: { enabled: true, hasQuestions: true, responses: 10 },
    },
  },
});
