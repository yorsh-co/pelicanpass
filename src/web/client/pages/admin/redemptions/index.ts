import { dateTimeLocale } from '../../../../../i18n/locales.ts';
import api from '../../../core/api/index.ts';
import { startPollLoop } from '../../../modules/ui/poll-loop.ts';
import { SUMMARY_COPY } from './messages.ts';
import { openRowsOnClick } from '../shared/row-open.ts';

import type {
  RedemptionCounts,
  RedemptionSummary,
} from '../../../core/api/api.admin.redemptions.ts';
import type { PollState } from '../../../modules/ui/poll-loop.ts';

/**
 * The redemptions screen's two enhancements: live totals, and opening a record
 * by clicking anywhere in its row.
 *
 * The server renders a complete first paint and the page works without this
 * bundle. The poll only writes figures into cells the template already
 * rendered, keyed by `data-summary-item` and `data-summary-option`; an option
 * that first appears after the page loaded shows on the next load. The list
 * is not refreshed — it is a filtered search result, and rows moving under the
 * pointer while somebody reaches for one is worse than a list a few seconds old.
 */

/** How often the totals are refreshed. */
const POLL_MS = 10_000;

const root = document.querySelector<HTMLElement>('[data-redemptions="root"]');

/** The loop's current verdict, so a late refresh does not claim to be live. */
let state: PollState = 'live';

/** When the last snapshot was generated, already formatted. */
let updatedAt = '';

/**
 * Formats a snapshot time the way the server formatted the first paint: in the
 * event's timezone, which the page carries, rather than the device's.
 *
 * @param iso - The snapshot's `generatedAt`.
 */
const formatTime = (iso: string): string => {
  // An empty attribute means the route had no zone to give: use the device's.
  const zone = root?.dataset.timezone;
  const timeZone = zone === '' ? undefined : zone;

  const lang = document.documentElement.lang;

  return new Intl.DateTimeFormat(lang ? dateTimeLocale(lang) : undefined, {
    timeStyle: 'medium',
    timeZone,
  }).format(new Date(iso));
};

/**
 * Writes one set of counts into the cells under a host element.
 *
 * @param host - The card or the breakdown row.
 * @param counts - What to write.
 */
const writeCounts = (host: Element, counts: RedemptionCounts): void => {
  for (const field of [
    'expected',
    'redeemed',
    'pendingPresent',
    'pendingAbsent',
  ] as const) {
    const cell = host.querySelector(`[data-field="${field}"]`);

    if (cell) cell.textContent = String(counts[field]);
  }

  const progress = host.querySelector('[data-field="progress"]');

  if (progress && counts.share !== null) {
    progress.textContent = SUMMARY_COPY.progress(counts.share);
  }
};

/**
 * Paints a snapshot into the rendered totals.
 *
 * Matched by comparing `dataset` values rather than by building a selector:
 * an option is free text off the approved list, and quoting it into a selector
 * is one escaping mistake away from matching nothing.
 *
 * @param snapshot - The refreshed totals.
 */
const render = (snapshot: RedemptionSummary): void => {
  if (!root) return;

  for (const entry of snapshot.items) {
    for (const host of root.querySelectorAll<HTMLElement>(
      '[data-summary-item]',
    )) {
      if (host.dataset.summaryItem !== entry.item) continue;

      const option = host.dataset.summaryOption;

      if (option === undefined) {
        writeCounts(host, entry);

        continue;
      }

      const counts = entry.options.find((row) => row.option === option);

      if (counts) writeCounts(host, counts);
    }
  }

  updatedAt = formatTime(snapshot.generatedAt);
};

/**
 * Paints the liveness line.
 *
 * @param next - The loop's verdict.
 */
const setState = (next: PollState): void => {
  state = next;

  if (root) root.dataset.state = next;

  const line = root?.querySelector('[data-redemptions="state"]');

  if (!line) return;

  if (state === 'stale') line.textContent = SUMMARY_COPY.stale;
  else if (updatedAt) line.textContent = SUMMARY_COPY.updated(updatedAt);
};

// Only list rows carry an open button; the breakdown's rows have none and are
// left alone.
openRowsOnClick(
  document.querySelectorAll<HTMLTableRowElement>(
    '.redemptions__list .admin-table tbody tr',
  ),
);

if (root) {
  startPollLoop<RedemptionSummary>({
    fetch: () => api.admin.redemptions.summary(),
    render,
    setState,
    // The liveness line names the last refresh rather than counting down to
    // the next: the figures change a few times a minute, and a ticking clock
    // beside them would draw the eye for no reason.
    tick: () => undefined,
    intervalMs: POLL_MS,
  });
}
