import { createAdminMetricsMessages } from '../../../../../i18n/generated/admin-metrics.messages.ts';
import { createAdminAttendeesMessages } from '../../../../../i18n/generated/admin-attendees.messages.ts';
import { ticketPrefixKind } from '../../../../../constants/ticket.ts';
import { readMessages } from '../../../core/i18n.ts';

const metrics = readMessages('admin-metrics', createAdminMetricsMessages);

/**
 * The `admin-attendees` catalog, for the ticket limit block, which reuses the
 * roster's meter and its wording rather than keeping a second copy.
 */
export const LIMIT_COPY = readMessages(
  'admin-attendees',
  createAdminAttendeesMessages,
);

/**
 * What the live panel's script writes, read from the `admin-metrics` catalog
 * the route inlined. Everything the script never rewrites — headings, tooltips,
 * limiter descriptions — is rendered by `metrics/index.ejs`.
 */
export const METRICS_COPY = {
  healthOk: metrics.healthOk(),
  healthDown: metrics.healthDown(),
  healthUnknown: metrics.healthUnknown(),
  depDown: metrics.healthDepDown(),
  depUnknown: metrics.healthDepUnknown(),
  duration: (ms: number): string => metrics.healthDuration({ ms }),
  uptime: (minutes: number): string => metrics.healthUptimeValue({ minutes }),
  lastAlert: (title: string): string => metrics.healthLastAlert({ title }),
  noAlerts: metrics.healthNoAlerts(),

  appDown: metrics.outageAppDown(),
  readinessRefused: metrics.outageReadinessRefused(),
  readinessUnavailable: metrics.outageReadinessUnavailable(),
  redisDown: metrics.outageRedisDown(),
  postgresDown: metrics.outagePostgresDown(),
  sessionExpired: metrics.outageSessionExpired(),
  refreshing: metrics.refreshing(),
  disconnected: metrics.disconnected(),

  windowState: (state: 'none' | 'open' | 'closed'): string =>
    metrics.windowState({ state }),
  bucket: (ms: number): string => metrics.latencyBucket({ ms }),

  keyCount: (count: number): string => metrics.limitsKeyCount({ count }),
  points: (points: number): string => metrics.limitsPoints({ points }),
  sessions: (sessions: number): string => metrics.limitsSessions({ sessions }),

  checkinPrefix: (prefix: string): string =>
    metrics.doorPrefix({ kind: ticketPrefixKind(prefix), prefix }),

  surveyStatus: (
    state: 'open' | 'closed',
    reason: 'disabled' | 'override' | 'schedule',
  ): string => metrics.surveyStatus({ state, reason }),
  surveyCloses: (at: string): string => metrics.surveyCloses({ at }),
  surveyUnit: (count: number): string => metrics.surveyUnit({ count }),
  surveyOff: metrics.surveyOff(),

  errorCount: (count: number): string => metrics.errorsCount({ count }),
  signature: (fingerprint: string): string =>
    metrics.errorsSignature({ fingerprint }),
  noErrors: metrics.errorsNone(),
} as const;
