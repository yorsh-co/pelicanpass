import { excessOf, meterFill, meterNow, remainingOf } from './ticket-limit.ts';

import type { createAdminAttendeesMessages } from '../../../../../i18n/generated/admin-attendees.messages.ts';
import type { TicketLimitOverview } from '../../../../../types/ticket-limit.ts';

/**
 * Draws the ticket limit's meter from an overview.
 *
 * Shared by the roster's panel and the record form's banner, and used for both
 * the first paint and every redraw, so the markup in
 * `partials/ticket-limit-meter.ejs` has one writer after the server's. The
 * fill's width is set here, through the CSSOM, because the page's CSP does not
 * allow the inline style attribute the server would otherwise have written.
 */

type Messages = ReturnType<typeof createAdminAttendeesMessages>;

/** The slice of the `admin-attendees` catalog the meter reads. */
export type LimitMeterCopy = Pick<
  Messages,
  'limitLeft' | 'limitOver' | 'limitMeterText' | 'limitUsage'
>;

/**
 * Says how many tickets are left, or how many are over.
 *
 * @param copy - The catalog.
 * @param overview - A limit that is on.
 */
export const limitDetail = (
  copy: LimitMeterCopy,
  overview: TicketLimitOverview,
): string => {
  const scope = overview.scope === 'door' ? 'door' : 'total';

  return overview.status === 'over'
    ? copy.limitOver({ scope, excess: excessOf(overview) })
    : copy.limitLeft({ scope, remaining: remainingOf(overview) });
};

/**
 * Rewrites the meter and its usage line under `root`.
 *
 * Both are hidden when there is no limit, rather than removed, so a later
 * redraw can bring them back.
 *
 * @param root - The panel or banner holding the partial's markup.
 * @param copy - The catalog.
 * @param overview - The limit to draw.
 */
export const paintLimitMeter = (
  root: ParentNode,
  copy: LimitMeterCopy,
  overview: TicketLimitOverview,
): void => {
  const meter = root.querySelector<HTMLElement>('[data-limit-meter]');
  const fill = root.querySelector<HTMLElement>('[data-limit-fill]');
  const usage = root.querySelector<HTMLElement>('[data-limit-usage]');

  const on = overview.status !== 'off' && overview.cap !== null;
  const cap = overview.cap ?? 0;
  const detail = on ? limitDetail(copy, overview) : '';

  if (meter) {
    meter.hidden = !on;
    meter.dataset.status = overview.status;
    meter.setAttribute('aria-valuemax', String(cap));
    meter.setAttribute('aria-valuenow', String(meterNow(overview)));
    meter.setAttribute(
      'aria-valuetext',
      on ? copy.limitMeterText({ used: overview.used, cap, detail }) : '',
    );
  }

  fill?.style.setProperty('--limit-fill', String(meterFill(overview)));

  if (usage) {
    usage.hidden = !on;
    usage.dataset.status = overview.status;
    usage.textContent = on
      ? copy.limitUsage({ used: overview.used, cap, detail })
      : '';
  }
};
