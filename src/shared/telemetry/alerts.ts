import { env } from '../../config/env.ts';
import { logger } from '../logger/logger.ts';

import { scrub } from './scrub.ts';

/**
 * How loud an alert is, and which channel it lands in.
 *
 * `critical` means "somebody should look now, at 20:00, on a phone". Everything
 * else is a thing to read between arrivals. Keeping that line sharp is what
 * stops the critical channel becoming ignorable.
 */
export type AlertSeverity = 'warn' | 'error' | 'critical';

export interface Alert {
  readonly severity: AlertSeverity;
  readonly title: string;
  /**
   * Stable identity for the condition, not the occurrence. Two firings of the
   * same rule share a fingerprint and collapse; a different rule does not.
   */
  readonly fingerprint: string;
  /**
   * One line: what this actually means, in plain terms.
   *
   * Required rather than optional, and that is the point. An alert read at
   * 20:00 should not need the runbook open beside it, and a field a caller may
   * omit is one the next rule will be written without. The compiler enumerates
   * every call site instead.
   */
  readonly means: string;
  /** One line: the first thing to look at. */
  readonly check: string;
  readonly fields?: Readonly<Record<string, string | number | boolean>>;
}

interface Suppression {
  /** Firings since the last message went out, excluding the one that was sent. */
  suppressed: number;
  firstSeen: number;
  lastSent: number;
}

const COLOURS: Record<AlertSeverity, number> = {
  warn: 0xd9_a1_06,
  error: 0xd0_4a_3b,
  critical: 0x9b_1c_1c,
};

const ICONS: Record<AlertSeverity, string> = {
  warn: '⚠️',
  error: '🔴',
  critical: '🚨',
};

/**
 * Bounded, because a fingerprint derives partly from request shape and an
 * unbounded map is therefore a memory leak an attacker can drive. At the cap the
 * coldest entries go; losing a suppression record costs one duplicate message,
 * which is the cheap direction to fail in.
 */
const MAX_TRACKED = 500;

const suppressions = new Map<string, Suppression>();

/**
 * The most recent alert this process decided to send.
 *
 * Recorded at the point it is claimed rather than after delivery: the health
 * panel is asking "when did something last go wrong", and an alert that fired
 * and then failed to reach Discord is a more urgent answer to that, not a less
 * one. A `null` means nothing has fired since boot.
 */
let lastAlert: { severity: AlertSeverity; title: string; at: string } | null =
  null;

/**
 * Discord's webhook limit is roughly five requests per two seconds. One message
 * every two seconds stays well inside it while still draining a burst quickly
 * enough to be useful.
 */
const MIN_SEND_INTERVAL_MS = 2_000;

const queue: Alert[] = [];
let draining = false;

const webhookFor = (severity: AlertSeverity): string =>
  severity === 'critical' && env.alerts.criticalWebhookUrl
    ? env.alerts.criticalWebhookUrl
    : env.alerts.webhookUrl;

const evictColdest = (): void => {
  if (suppressions.size <= MAX_TRACKED) return;

  let coldestKey: string | null = null;
  let coldestAt = Number.POSITIVE_INFINITY;

  for (const [key, entry] of suppressions) {
    if (entry.lastSent < coldestAt) {
      coldestAt = entry.lastSent;
      coldestKey = key;
    }
  }

  if (coldestKey !== null) suppressions.delete(coldestKey);
};

/**
 * Whether this firing should produce a message, and how many it stands for.
 *
 * A suppressed repeat is counted rather than dropped, so the next message that
 * does go out can say how much it represents. "×47 since 20:14" is the
 * difference between a nuisance and a measurement.
 */
const claim = (alert: Alert): { send: boolean; suppressed: number } => {
  const now = Date.now();
  const existing = suppressions.get(alert.fingerprint);

  if (existing && now - existing.lastSent < env.alerts.dedupTtl) {
    existing.suppressed += 1;

    return { send: false, suppressed: existing.suppressed };
  }

  const suppressed = existing?.suppressed ?? 0;

  suppressions.set(alert.fingerprint, {
    suppressed: 0,
    firstSeen: existing?.firstSeen ?? now,
    lastSent: now,
  });

  evictColdest();

  return { send: true, suppressed };
};

const post = async (alert: Alert, suppressed: number): Promise<void> => {
  const url = webhookFor(alert.severity);

  if (!url) return;

  const fields = Object.entries(scrub(alert.fields ?? {})).map(
    ([name, value]) => ({
      name,
      value: '```' + String(value).slice(0, 300) + '```',
      inline: true,
    }),
  );

  const body = {
    username: 'pelicanpass',
    embeds: [
      {
        title: `${ICONS[alert.severity]} ${alert.title}`,
        color: COLOURS[alert.severity],
        fields: [
          ...fields,
          { name: 'release', value: env.releaseId, inline: true },
          // Not scrubbed, unlike everything above them: these are literals
          // written here, not values read from a request. Running them through
          // `scrub` would censor a sentence that happens to contain the word
          // "ticket" while proving nothing about the data beside it.
          { name: 'means', value: alert.means, inline: false },
          { name: 'check', value: alert.check, inline: false },
          ...(suppressed > 0
            ? [
                {
                  name: 'also',
                  value: `×${String(suppressed)} suppressed since the last message`,
                  inline: false,
                },
              ]
            : []),
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // A webhook that has stopped answering must not become a way to stall the
    // process on shutdown, which is where the flush below awaits this.
    signal: AbortSignal.timeout(3_000),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook responded ${String(response.status)}`);
  }
};

const drain = async (): Promise<void> => {
  if (draining) return;

  draining = true;

  try {
    while (queue.length > 0) {
      const next = queue.shift();

      if (!next) break;

      const { send, suppressed } = claim(next);

      // Suppressed firings cost nothing: no request, and no pacing delay
      // either, so a burst of duplicates drains instantly instead of holding
      // the queue behind a sleep per item.
      if (!send) continue;

      lastAlert = {
        severity: next.severity,
        title: next.title,
        at: new Date().toISOString(),
      };

      try {
        await post(next, suppressed);

        // Alerts that *fail* were logged from the start; alerts that succeed
        // were not, so with delivery enabled the only record a firing ever
        // left was a Discord message. That is the wrong place for it to be the
        // only record: the channel is outside the retention story, cannot be
        // grepped during an incident, and is the first thing to scroll. The
        // durable log is where "did this fire, and when" gets answered.
        logger.info(
          {
            severity: next.severity,
            title: next.title,
            fingerprint: next.fingerprint,
            suppressed,
          },
          'Alert delivered',
        );
      } catch (err) {
        // Logged and dropped. Never rethrown, and deliberately never retried:
        // a retry queue outlives the incident and delivers the backlog into a
        // channel where it is no longer true.
        logger.error(
          { err, fingerprint: next.fingerprint },
          'Alert delivery failed',
        );
      }

      if (queue.length > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, MIN_SEND_INTERVAL_MS),
        );
      }
    }
  } finally {
    draining = false;
  }
};

/**
 * Queues an alert for delivery.
 *
 * Returns immediately. Nothing in a request path may wait on a webhook, so
 * delivery happens on the drain loop and failure is absorbed there.
 *
 * Deduplication happens at send time rather than here, so a burst that arrives
 * while the queue is draining collapses into the count on the message that is
 * already on its way out.
 *
 * @param alert - The condition to report. `fields` must already be free of
 *   personal data — see the module note on what may not be sent.
 */
export const sendAlert = (alert: Alert): void => {
  if (!env.alerts.enabled) {
    logger.info({ alert }, 'Alert suppressed: alerting disabled');

    return;
  }

  if (!env.alerts.webhookUrl) {
    logger.warn({ alert }, 'Alert not delivered: no webhook configured');

    return;
  }

  queue.push(alert);

  void drain();
};

/**
 * Waits for the queue to empty, bounded.
 *
 * Called from the shutdown and crash paths, where the process is about to go
 * away and an undelivered alert is lost for good. The bound matters more than
 * completeness: a hung webhook must not be able to hold the container past
 * Docker's grace period and turn a clean stop into a SIGKILL.
 *
 * @param timeoutMs - How long to wait before giving up on the remainder.
 */
export const flushAlerts = async (timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while ((queue.length > 0 || draining) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (queue.length > 0) {
    logger.warn(
      { pending: queue.length },
      'Shutting down with alerts still queued',
    );
  }
};

/**
 * The last alert this process sent, for the health panel.
 *
 * @returns The alert, or `null` if none has fired since boot.
 */
export const latestAlert = (): {
  severity: AlertSeverity;
  title: string;
  at: string;
} | null => lastAlert;
