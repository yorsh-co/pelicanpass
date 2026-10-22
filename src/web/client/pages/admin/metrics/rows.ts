import { surveyCoverage } from '../../../../../constants/survey-coverage.ts';
import { dateTimeLocale } from '../../../../../i18n/locales.ts';
import { paintLimitMeter } from '../shared/limit-meter.ts';
import { LIMIT_COPY, METRICS_COPY } from './messages.ts';

import type { MetricsSnapshot } from '../../../core/api/api.admin.metrics.ts';

/**
 * Writes a fresh snapshot into the markup the server already rendered.
 *
 * **These update the page rather than rebuild it, and that is the whole
 * design.** An earlier version replaced each region's rows wholesale on every
 * poll, on the reasoning that a limiter's colour, bar, counts and fan-out badge
 * all move together. They do — but replacing the rows also destroyed whatever
 * the operator was doing with them: an open key list closed itself every five
 * seconds, a half-made text selection died, focus was thrown away.
 *
 * That reasoning had also quietly expired. It was written when limiter rows
 * appeared only as limiters were consumed, so the row *set* was dynamic. The
 * boot-time registry made it fixed and stably ordered, and six of the seven
 * polled regions have a fixed shape for similar reasons — three redemption
 * items, four latency routes, two windows. Only `top-errors` genuinely gains and
 * loses rows.
 *
 * So the server renders structure once, and these functions look a row up by its
 * identity and write values into it. Nothing an operator can interact with is
 * ever replaced, which is a stronger guarantee than restoring state after the
 * fact — there is no state to restore.
 *
 * It also collapses most of the duplication this module used to carry: the rows,
 * cells, classes and tooltips exist in the EJS alone now. What still exists
 * twice is the small derived arithmetic — `pct` and `level` — which both halves
 * need, and which the phase 4c gate compares.
 *
 * Values are written with `textContent`, never markup. Nearly all of it is
 * attacker-influenceable — an IP, a route, a thrown message — so the client half
 * is safe by construction rather than by remembering.
 */

/** Finds a value cell inside a row. */
const cell = (row: Element, name: string): HTMLElement | null =>
  row.querySelector<HTMLElement>(`[data-cell="${name}"]`);

/** Writes a cell's text, if the cell is there. */
const setCell = (row: Element, name: string, value: string | number): void => {
  const node = cell(row, name);

  if (node) node.textContent = String(value);
};

/**
 * Finds a row by a dataset value.
 *
 * Matched in JavaScript rather than through an attribute selector: the keys are
 * limiter prefixes and route paths, and building a selector by concatenation is
 * the kind of thing that is safe until the day one of them contains a quote.
 */
const rowBy = (
  host: HTMLElement,
  attribute: string,
  value: string,
): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>(`[data-${attribute}]`)].find(
    (row) => row.dataset[attribute] === value,
  );

/** Builds an element, optionally with a class and text. */
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string | number,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);

  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);

  return node;
};

/** Mirrors the `data-metrics="checkin-roles"` list, keyed by role. */
export const renderCheckinRoles = (
  host: HTMLElement,
  snapshot: MetricsSnapshot,
): void => {
  for (const row of snapshot.checkins) {
    const node = rowBy(host, 'role', row.attendeeRole);

    if (node) {
      setCell(
        node,
        'count',
        `${String(row.checkedIn)} / ${String(row.expected)}`,
      );
    }
  }
};

/**
 * Mirrors the `data-metrics="checkin-prefixes"` list under the participants row.
 *
 * Rebuilt whole, unlike `renderCheckinRoles`: the prefix set is not fixed, and
 * the first generated `d` walk-in of the event adds a row mid-poll. Nothing in
 * it is interactive, so there is no state to carry across.
 */
export const renderCheckinPrefixes = (
  host: HTMLElement,
  snapshot: MetricsSnapshot,
): void => {
  host.replaceChildren(
    ...snapshot.checkinPrefixes.map((row) => {
      const item = el('div', 'panel__row');

      item.append(
        el('dt', undefined, METRICS_COPY.checkinPrefix(row.prefix)),
        el(
          'dd',
          undefined,
          `${String(row.checkedIn)} / ${String(row.expected)}`,
        ),
      );

      return item;
    }),
  );
};

/**
 * Mirrors the `data-metrics="ticket-limit"` block on the door panel.
 *
 * Hidden while the limit is off or its read failed (`null`) and revealed again
 * when a later poll finds it on, so a limit switched on mid-event shows without
 * a reload. The meter is `paintLimitMeter`'s, as on the roster.
 */
export const renderTicketLimit = (
  host: HTMLElement,
  snapshot: MetricsSnapshot,
): void => {
  const overview = snapshot.ticketLimit;
  const on = overview !== null && overview.status !== 'off';

  host.hidden = !on;

  if (!on) return;

  setCell(
    host,
    'setting',
    `${LIMIT_COPY.limitScopeOption({ scope: overview.scope })} · ${LIMIT_COPY.limitMode({ mode: overview.mode })}`,
  );
  paintLimitMeter(host, LIMIT_COPY, overview);
};

/**
 * Mirrors the `data-metrics="survey"` card.
 *
 * Hidden while the read failed (`null`) or there is nothing to show, and
 * revealed again when a later poll finds something. The card is absent from the
 * page for an administrator without `export:read`, and the snapshot then
 * carries `null`, so this is never called on it.
 *
 * Totals only: the survey keeps a date and no time, so there is no rate.
 */
export const renderSurvey = (
  host: HTMLElement,
  snapshot: MetricsSnapshot,
): void => {
  const overview = snapshot.survey;
  const coverage = overview
    ? surveyCoverage(overview, snapshot.checkins)
    : null;

  host.hidden = !coverage?.visible;

  if (!overview || !coverage) return;

  setCell(host, 'total', coverage.total);
  setCell(host, 'unit', METRICS_COPY.surveyUnit(coverage.total));
  setCell(
    host,
    'status',
    METRICS_COPY.surveyStatus(
      overview.state.open ? 'open' : 'closed',
      overview.state.reason,
    ),
  );

  const closes = cell(host, 'closes');
  const zone = host.dataset.timezone;
  const lang = document.documentElement.lang;

  if (closes) {
    const closing =
      overview.state.open && overview.closesAt !== null
        ? new Intl.DateTimeFormat(lang ? dateTimeLocale(lang) : undefined, {
            dateStyle: 'short',
            timeStyle: 'short',
            // An empty attribute means the route had no zone to give.
            timeZone: zone === '' ? undefined : zone,
          }).format(overview.closesAt)
        : null;

    closes.hidden = closing === null;
    closes.textContent =
      closing === null ? '' : `· ${METRICS_COPY.surveyCloses(closing)}`;
  }

  for (const node of host.querySelectorAll<HTMLElement>('[data-audience]')) {
    const row = coverage.rows.find((r) => r.audience === node.dataset.audience);

    node.hidden = !row;

    if (!row) continue;

    setCell(
      node,
      'count',
      !row.off
        ? `${String(row.answered)} / ${String(row.checkedIn)}`
        : row.answered > 0
          ? `${String(row.answered)} · ${METRICS_COPY.surveyOff}`
          : METRICS_COPY.surveyOff,
    );
  }
};

/** Mirrors the `data-metrics="windows"` list, keyed by role. */
export const renderWindows = (
  host: HTMLElement,
  snapshot: MetricsSnapshot,
): void => {
  for (const w of snapshot.windows) {
    const node = rowBy(host, 'window', w.role);

    if (!node) continue;

    setCell(
      node,
      'state',
      METRICS_COPY.windowState(
        w.opensAt === null ? 'none' : w.open ? 'open' : 'closed',
      ),
    );

    node.classList.toggle('panel__note--open', w.open);
    node.classList.toggle('panel__note--shut', !w.open);
  }
};

/** Mirrors the `data-metrics="redemptions"` table body, keyed by item. */
export const renderRedemptions = (
  host: HTMLElement,
  snapshot: MetricsSnapshot,
): void => {
  const totalFor = (item: string, outcome: string): number =>
    snapshot.redemptions
      .filter((r) => r.item === item && r.outcome === outcome)
      .reduce((a, r) => a + r.total, 0);

  for (const row of host.querySelectorAll<HTMLElement>('[data-item]')) {
    const item = row.dataset.item ?? '';

    setCell(row, 'redeemed', totalFor(item, 'redeemed'));

    // These two carry a warning class as well as a number: both at zero is the
    // normal evening, and either climbing is the panel's actual signal.
    for (const outcome of ['duplicate', 'not_entitled']) {
      const total = totalFor(item, outcome);
      const node = cell(row, outcome);

      if (!node) continue;

      node.textContent = String(total);
      node.classList.toggle('is-warn', total > 0);
    }
  }
};

/**
 * Writes the two dependency rows, keyed by dependency.
 *
 * Takes the health object rather than a whole snapshot so the outage path can
 * call it: when a poll fails the page falls back to `/readyz`, which returns
 * this same shape and — unlike the snapshot — needs no session. That fallback is
 * the only way this panel can be truthful about Redis being down, because the
 * snapshot's own session lookup goes through Redis.
 *
 * @param host - The `data-metrics="health-rows"` list.
 * @param health - The probes, or `null` when the readiness check could not be
 *   read and neither verdict is available.
 */
export const renderDependencyHealth = (
  host: HTMLElement,
  health: MetricsSnapshot['health'] | null,
): void => {
  for (const name of ['redis', 'postgres'] as const) {
    const probe = health?.[name];
    const node = rowBy(host, 'dep', name);

    if (!node) continue;

    const state = cell(node, 'state');

    if (!state) continue;

    // `undefined` is the unknown state: the readiness check could not be read,
    // so this row has no basis for either verdict. See `setOverallHealth`.
    if (!probe) {
      state.textContent = METRICS_COPY.depUnknown;
      state.classList.remove('is-ok', 'is-down');
      state.classList.add('is-unknown');

      continue;
    }

    state.textContent = probe.ok
      ? METRICS_COPY.duration(probe.durationMs)
      : METRICS_COPY.depDown;
    state.classList.remove('is-unknown');
    state.classList.toggle('is-ok', probe.ok);
    state.classList.toggle('is-down', !probe.ok);
  }
};

/** Mirrors the `data-metrics="health-rows"` list. */
export const renderHealthRows = (
  host: HTMLElement,
  snapshot: MetricsSnapshot,
): void => {
  renderDependencyHealth(host, snapshot.health);
};

/** Mirrors the `data-metrics="latency"` table body, keyed by route. */
export const renderLatency = (
  host: HTMLElement,
  snapshot: MetricsSnapshot,
): void => {
  for (const [route, l] of Object.entries(snapshot.latency)) {
    const node = rowBy(host, 'route', route);

    if (!node) continue;

    // Bucket edges, not interpolated values — "≤ 250 ms" is what a bucketed
    // histogram can honestly claim. Same message as the view.
    setCell(node, 'p50', l.p50 === null ? '—' : METRICS_COPY.bucket(l.p50));
    setCell(node, 'p95', l.p95 === null ? '—' : METRICS_COPY.bucket(l.p95));
    setCell(node, 'count', l.count);
  }
};

/**
 * Mirrors the `data-metrics="limiters"` table body, keyed by limiter name.
 *
 * The header cell is never touched: the name, the tier badge and the whole
 * tooltip come from the boot-time registry and cannot change while the process
 * runs. Four things move — the row's level class, the bar's fill, the peak
 * figure and the refusal count — plus the key list, which is replaced inside a
 * `<details>` that is itself never replaced.
 */
export const renderLimiters = (
  host: HTMLElement,
  snapshot: MetricsSnapshot,
): void => {
  const fanoutFor = (key: string): number | undefined =>
    snapshot.fanout.find((f) => f.ip === key)?.sessions;

  for (const l of snapshot.limiters) {
    const row = rowBy(host, 'limiter', l.name);

    if (!row) continue;

    const pct = l.ceiling
      ? Math.min(100, Math.round((l.peak / l.ceiling) * 100))
      : 0;

    const level = l.refused > 0 ? 'red' : pct >= 80 ? 'amber' : 'ok';

    for (const name of ['ok', 'amber', 'red']) {
      row.classList.toggle(`limiters__row--${name}`, name === level);
    }

    cell(row, 'bar')?.style.setProperty('--fill', `${String(pct)}%`);

    setCell(
      row,
      'peak',
      `${String(l.peak)} / ${l.ceiling === null ? '?' : String(l.ceiling)}`,
    );

    setCell(row, 'refused', l.refused);

    const details = cell(row, 'keys');
    const empty = cell(row, 'no-keys');
    const list = cell(row, 'keys-list');

    if (!details || !empty || !list) continue;

    // Toggled rather than swapped, so the `<details>` survives a limiter going
    // quiet and busy again. `open` lives on it, and an operator reading a long
    // list should not lose their place to a poll.
    details.hidden = l.topKeys.length === 0;
    empty.hidden = l.topKeys.length > 0;

    setCell(row, 'keys-summary', METRICS_COPY.keyCount(l.topKeys.length));

    list.replaceChildren(
      ...l.topKeys.map((k) => {
        const entry = el('li');

        entry.append(
          el('code', undefined, k.key),
          el('span', 'limiters__points', METRICS_COPY.points(k.points)),
        );

        const sessions = fanoutFor(k.key);

        if (sessions !== undefined) {
          entry.append(
            el('span', 'limiters__fanout', METRICS_COPY.sessions(sessions)),
          );
        }

        return entry;
      }),
    );
  }
};

/**
 * Mirrors the `data-metrics="top-errors"` list.
 *
 * The one region rebuilt wholesale, because it is the one whose rows genuinely
 * come and go — a signature ages out of the fifteen-minute window and should
 * disappear. So it is also the only region needing an open expander carried
 * across, keyed by fingerprint. A signature that has aged out will not match,
 * which is right: the thing being read is gone.
 */
export const renderTopErrors = (
  host: HTMLElement,
  snapshot: MetricsSnapshot,
): void => {
  const open = new Set(
    [
      ...host.querySelectorAll<HTMLDetailsElement>(
        'details[data-disclosure][open]',
      ),
    ].map((details) => details.dataset.disclosure),
  );

  if (snapshot.topErrors.length === 0) {
    host.replaceChildren(el('li', 'panel__empty', METRICS_COPY.noErrors));

    return;
  }

  host.replaceChildren(
    ...snapshot.topErrors.map((e) => {
      const item = el('li', 'panel__list-item');
      const details = el('details');
      const summary = el('summary');

      details.dataset.disclosure = e.fingerprint;
      details.open = open.has(e.fingerprint);

      summary.append(
        el('span', 'panel__count', METRICS_COPY.errorCount(e.occurrences)),
        el('code', undefined, e.code ?? 'UNKNOWN'),
        el('span', 'panel__route', e.route ?? '—'),
      );

      details.append(
        summary,
        el('p', 'panel__detail', e.message),
        el(
          'p',
          'panel__detail panel__detail--dim',
          METRICS_COPY.signature(e.fingerprint),
        ),
      );

      item.append(details);

      return item;
    }),
  );
};
