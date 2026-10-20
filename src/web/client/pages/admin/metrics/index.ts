import api from '../../../core/api/index.ts';
import { startPollLoop } from '../../../modules/ui/poll-loop.ts';

import {
  renderCheckinPrefixes,
  renderCheckinRoles,
  renderDependencyHealth,
  renderHealthRows,
  renderLatency,
  renderLimiters,
  renderRedemptions,
  renderSurvey,
  renderTicketLimit,
  renderTopErrors,
  renderWindows,
} from './rows.ts';
import { LIMIT_COPY, METRICS_COPY } from './messages.ts';
import { paintLimitMeter } from '../shared/limit-meter.ts';
import { parseOverview } from '../shared/ticket-limit.ts';

import type { MetricsSnapshot } from '../../../core/api/api.admin.metrics.ts';
import type { PollState } from '../../../modules/ui/poll-loop.ts';

/**
 * Keeps the live panel current.
 *
 * The server renders a complete snapshot and this replaces it on every poll —
 * scalar figures in place, tables and lists rebuilt through `rows.ts`.
 *
 * This deliberately **does** build markup the server also builds. The earlier
 * rule was that it must not, to keep the JavaScript-off rendering from drifting
 * into a degraded copy; applied to tables it meant every table on the page was
 * frozen at the first paint while the figures beside them kept moving, so the
 * screen looked live and was not. `rows.ts` carries the duplication and the note
 * about keeping the two halves in step.
 */

/** How often the panel asks for a new snapshot. */
const POLL_MS = 5_000;

const root = document.querySelector<HTMLElement>('[data-metrics="root"]');

/** The loop's current verdict, so the countdown can word itself correctly. */
let state: PollState = 'live';

/**
 * What is actually wrong, when a poll fails.
 *
 * `null` while things are working. Otherwise a short phrase naming the cause,
 * so the status line names the failing dependency rather than only saying the
 * panel is disconnected — the dashboard's whole job during an outage is to say
 * which one.
 */
let outage: string | null = null;

const pick = (name: string): HTMLElement | null =>
  root?.querySelector<HTMLElement>(`[data-metrics="${name}"]`) ?? null;

const setText = (name: string, value: string | number): void => {
  const el = pick(name);

  if (el) el.textContent = String(value);
};

const sumLast = (series: Record<string, number[]>, name: string): number =>
  series[name]?.slice(-1)[0] ?? 0;

/**
 * Redraws a sparkline's points.
 *
 * Same geometry as the server's: a polyline over a 0..100 by 0..30 box, scaled
 * by the viewBox so the stylesheet owns the size. Two copies of this would agree
 * until one of them was edited, so the shape is deliberately trivial.
 */
const drawSpark = (name: string, values: number[] | undefined): void => {
  const el = pick(name);

  if (!el) return;

  const points = (values ?? []).slice(-60);

  if (points.length === 0) {
    el.setAttribute('points', '');

    return;
  }

  const max = Math.max(...points, 1);
  const step = points.length > 1 ? 100 / (points.length - 1) : 0;

  el.setAttribute(
    'points',
    points
      .map(
        (n, i) =>
          `${(i * step).toFixed(2)},${(30 - (n / max) * 30).toFixed(2)}`,
      )
      .join(' '),
  );
};

/**
 * Paints the Health panel's headline, from a snapshot, `/readyz`, or neither.
 *
 * `null` is the third state and it is not a cosmetic one: it is the difference
 * between "both dependencies answer" and "nobody could be asked". Leaving the
 * panel on its last good reading while the probe is unreachable is the panel
 * asserting something it has no basis for, on the screen somebody opens to find
 * out what is wrong.
 *
 * @param health - The probes, or `null` when the readiness check could not be
 *   read at all.
 */
const setOverallHealth = (health: MetricsSnapshot['health'] | null): void => {
  const overall = pick('health-overall');

  if (!overall) return;

  const ok = health !== null && health.redis.ok && health.postgres.ok;
  const unknown = health === null;

  overall.classList.toggle('panel__status--ok', ok);
  overall.classList.toggle('panel__status--down', !ok && !unknown);
  overall.classList.toggle('panel__status--unknown', unknown);

  const icon = overall.querySelector('.material-symbols-outlined');
  let label = METRICS_COPY.healthDown;

  if (ok) label = METRICS_COPY.healthOk;
  else if (unknown) label = METRICS_COPY.healthUnknown;

  if (icon) {
    // `info` rather than a question mark: the subset is frozen at the 37 names
    // in docs/infrastructure/asset-delivery.md, and an icon outside it renders as its own
    // ligature text.
    /* copy-ok: icon ligature */
    icon.textContent = ok ? 'check' : unknown ? 'info' : 'error';
  }

  // The text node after the icon, rewritten without disturbing the icon.
  const text = overall.lastChild;

  if (text) text.textContent = ` ${label}`;
  else overall.append(label);
};

/**
 * Works out what is wrong when a poll fails, and keeps the Health panel honest.
 *
 * **This is the only path that can report a Redis outage.** The snapshot sits
 * behind `requireSessionType('admin')` and sessions live in Redis, so Redis
 * going down answers 401 — indistinguishable, to the loop, from a session that
 * simply expired. `/readyz` needs no session and names the failing dependency,
 * so it is asked whenever the snapshot will not answer.
 *
 * A `/readyz` that reports everything healthy is informative too: the
 * dependencies are fine and the refusal was about *this operator*, which is a
 * sign-in problem rather than an outage and wants a different action.
 */
const diagnose = async (): Promise<void> => {
  const report = await api.admin.metrics.readiness();

  // Three ways the probe can fail to produce a report, and none of them says
  // anything about the dependencies. The panel is marked unknown on all three
  // rather than left on its last good reading: a Health panel still reading
  // "todas as dependências respondendo" while nothing can be asked is worse
  // than one admitting it does not know.
  if (report === null || report === 'refused' || report === 'unavailable') {
    if (report === null) outage = METRICS_COPY.appDown;
    else if (report === 'refused') outage = METRICS_COPY.readinessRefused;
    // It answered, but not with a report — its own rate limiter, most likely.
    // Saying "not responding" here would be a plain untruth about a process
    // that just replied.
    else outage = METRICS_COPY.readinessUnavailable;

    const unknownHost = pick('health-rows');

    if (unknownHost) renderDependencyHealth(unknownHost, null);

    setOverallHealth(null);

    return;
  }

  const { redis, postgres } = report.dependencies;

  // Keep the panel live through the outage rather than frozen on the last good
  // snapshot. This is the one panel that should be moving while everything else
  // has stopped.
  const host = pick('health-rows');

  if (host) renderDependencyHealth(host, report.dependencies);

  setOverallHealth(report.dependencies);

  // Kept to one clause each: the status line appends the age of the data, and
  // a second em dash in the cause turns the whole thing into a queue of them.
  // The consequence — that a Redis outage means sessions are gone — is on the
  // Health panel and in the alert, which is where somebody acting on it looks.
  if (!redis.ok) outage = METRICS_COPY.redisDown;
  else if (!postgres.ok) outage = METRICS_COPY.postgresDown;
  else outage = METRICS_COPY.sessionExpired;
};

const render = (snapshot: MetricsSnapshot): void => {
  outage = null;

  const series = snapshot.series;

  setText(
    'generated',
    new Date(snapshot.generatedAt).toLocaleString(
      document.documentElement.lang,
    ),
  );
  setText(
    'uptime',
    METRICS_COPY.uptime(Math.floor(snapshot.uptimeSeconds / 60)),
  );

  const totalIn = snapshot.checkins.reduce((a, r) => a + r.checkedIn, 0);
  const totalExpected = snapshot.checkins.reduce((a, r) => a + r.expected, 0);

  setText('checkin-total', totalIn);
  setText('checkin-expected', totalExpected);
  setText('checkin-rate', sumLast(series, 'checkin.complete'));
  setText('redeem-rate', sumLast(series, 'redeem.redeemed'));
  setText('error-rate', sumLast(series, 'severity.error'));

  drawSpark('spark-checkin', series['checkin.complete']);
  drawSpark('spark-error', series['severity.error']);

  setOverallHealth(snapshot.health);

  const alert = pick('last-alert');

  if (alert) {
    alert.textContent = snapshot.lastAlert
      ? METRICS_COPY.lastAlert(snapshot.lastAlert.title)
      : METRICS_COPY.noAlerts;
  }

  // The regions phase 4 never touched. Each is rebuilt whole because the parts
  // of a row move together — a limiter's colour, bar, refusal count and fan-out
  // badge are one reading, not four.
  const regions: [string, (h: HTMLElement, s: MetricsSnapshot) => void][] = [
    ['checkin-roles', renderCheckinRoles],
    ['checkin-prefixes', renderCheckinPrefixes],
    ['ticket-limit', renderTicketLimit],
    ['windows', renderWindows],
    ['redemptions', renderRedemptions],
    ['survey', renderSurvey],
    ['health-rows', renderHealthRows],
    ['latency', renderLatency],
    ['top-errors', renderTopErrors],
    ['limiters', renderLimiters],
  ];

  for (const [name, draw] of regions) {
    const host = pick(name);

    if (host) draw(host, snapshot);
  }
};

const tick = (remainingMs: number, fraction: number): void => {
  const seconds = Math.ceil(remainingMs / 1000);

  if (state === 'live') {
    setText('countdown', seconds > 0 ? `` : METRICS_COPY.refreshing);
  } else if (state === 'stale') {
    setText('countdown', outage ?? METRICS_COPY.disconnected);
  }

  pick('ring')?.style.setProperty('--poll-remaining', fraction.toFixed(3));
};

const setState = (next: PollState): void => {
  state = next;

  // On the root, not on the status line. The grid is a sibling of `<header>`
  // rather than of that paragraph, so a selector written against the paragraph
  // could never reach it — which is how the "these numbers are stale" dimming
  // shipped dead while looking correct in the stylesheet.
  if (root) root.dataset.state = next;
};

if (root) {
  // The server renders each bar's fill as data: an inline `style` would need
  // `style-src 'unsafe-inline'`. Painting through CSSOM is not subject to it.
  for (const bar of root.querySelectorAll<HTMLElement>('[data-fill]')) {
    bar.style.setProperty('--fill', `${bar.dataset.fill ?? '0'}%`);
  }

  // The ticket limit's fill is a custom property too, and the server cannot
  // write it. Painted from the first snapshot's markup rather than waiting five
  // seconds for a poll, so the bar is not empty until then.
  const limit = pick('ticket-limit');
  const initialLimit = parseOverview(limit?.dataset.limitOverview);

  if (limit && initialLimit) paintLimitMeter(limit, LIMIT_COPY, initialLimit);

  const loop = startPollLoop<MetricsSnapshot>({
    fetch: async () => {
      try {
        return await api.admin.metrics.snapshot();
      } catch (err) {
        // Diagnose before rethrowing. The loop only needs to know the poll
        // failed; the operator needs to know *why*, and the snapshot itself
        // cannot say — a Redis outage stops it answering at all.
        await diagnose();

        throw err;
      }
    },
    render,
    setState,
    tick,
    intervalMs: POLL_MS,
  });

  const refresh = pick('refresh');

  if (refresh instanceof HTMLAnchorElement) {
    refresh.addEventListener('click', (event) => {
      // The href is a real page load and stays that way with JavaScript off.
      // With it on, refreshing in place is strictly better: it keeps scroll
      // position and every open disclosure.
      event.preventDefault();

      if (refresh.getAttribute('aria-disabled') === 'true') return;

      void (async () => {
        refresh.setAttribute('aria-disabled', 'true');

        await loop.retry();

        // Re-armed on the loop's own cadence. While an attempt is in flight, or
        // one is about to fire by itself, a second click has nothing to offer —
        // and this endpoint shares a 60/minute budget with the poll itself.
        window.setTimeout(() => {
          refresh.removeAttribute('aria-disabled');
        }, POLL_MS);
      })();
    });
  }
}
