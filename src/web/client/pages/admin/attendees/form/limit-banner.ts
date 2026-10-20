import { qsOptional } from '../../../../layouts/main/dom.ts';
import { readMessages } from '../../../../core/i18n.ts';
import { createAdminAttendeesMessages } from '../../../../../../i18n/generated/admin-attendees.messages.ts';
import { paintLimitMeter } from '../../shared/limit-meter.ts';
import {
  assumeReached,
  parseOverview,
  wouldBlock,
} from '../../shared/ticket-limit.ts';

import type { TicketLimitOverview } from '../../../../../../types/ticket-limit.ts';

/**
 * The record form's ticket limit banner.
 *
 * Paints the meter from the overview the server left on the banner. On the
 * blank form it also keeps the submit button honest: while a hard limit with no
 * room left would refuse this very save (a participant, and in door scope a
 * blank code), the button is disabled and the banner says why. It recomputes as
 * the role and the ticket code change. A volunteer is never blocked. On an
 * archived record the same rule, applied to the record's stored role and code,
 * keeps the restore control disabled.
 *
 * The server stays the authority and checks again at save time; if the count
 * moved after the page loaded, its `ticketLimitReached` refusal arrives through
 * the form's ordinary error path.
 */

/** What the form's script asks of the banner. */
export interface LimitBanner {
  /** Whether the submit button must stay disabled right now. */
  blocked: () => boolean;

  /** Redraws the banner from a fresher overview, such as a create's answer. */
  update: (overview: TicketLimitOverview) => void;

  /**
   * Takes the limit as reached after the server refused a save for lack of
   * room, then repaints and re-evaluates the controls it governs.
   */
  markReached: () => void;
}

/** The banner of a page that rendered none: it blocks nothing. */
const ABSENT: LimitBanner = {
  blocked: () => false,
  update: () => undefined,
  markReached: () => undefined,
};

/**
 * Wires the banner, when the page rendered one.
 *
 * @returns The banner's controls; inert when there is no banner.
 */
export const setupLimitBanner = (): LimitBanner => {
  const banner = qsOptional('[data-limit-banner]');
  const initial = parseOverview(banner?.dataset.limitOverview);

  if (!banner || !initial) return ABSENT;

  const copy = readMessages('admin-attendees', createAdminAttendeesMessages);
  const message = banner.querySelector<HTMLElement>('[data-limit-blocked]');

  // The blank form decides its submit button. On an archived record only the
  // restore control is governed, from the record's stored role and code; saving
  // a record is never counted.
  const form = qsOptional<HTMLFormElement>('[data-attendee-form]');
  const creating = form !== null && form.dataset.attendeeId === undefined;
  const submit = qsOptional<HTMLButtonElement>('[data-attendee-submit]');
  const role = qsOptional<HTMLSelectElement>('#role');
  const code = qsOptional<HTMLInputElement>('#ticketCode');
  const restore = qsOptional<HTMLButtonElement>(
    '[data-attendee-archive][data-archived="true"]',
  );

  let overview = initial;
  let blocked = false;

  const evaluateRestore = (): void => {
    if (!restore) return;

    const next = wouldBlock(
      overview,
      banner.dataset.limitRole ?? '',
      code?.value ?? '',
    );

    if (message) message.hidden = !next;

    restore.disabled = next;

    if (next) restore.setAttribute('aria-describedby', 'limit-blocked');
    else restore.removeAttribute('aria-describedby');

    blocked = next;
  };

  const evaluate = (): void => {
    if (!creating) {
      evaluateRestore();

      return;
    }

    if (!role) return;

    // A disabled code field is left out of the submission, which is what asks
    // the server to generate one.
    const typed = code && !code.disabled ? code.value : '';
    const next = wouldBlock(overview, role.value, typed);

    if (message) message.hidden = !next;

    if (submit && next !== blocked) {
      submit.disabled = next;

      if (next) submit.setAttribute('aria-describedby', 'limit-blocked');
      else submit.removeAttribute('aria-describedby');
    }

    blocked = next;
  };

  paintLimitMeter(banner, copy, overview);
  blocked =
    (creating || restore !== null) && message !== null && !message.hidden;

  role?.addEventListener('change', evaluate);
  code?.addEventListener('input', evaluate);

  // A form restored by the browser may not start as the server rendered it.
  evaluate();

  return {
    blocked: () => blocked,
    update: (next) => {
      overview = next;
      banner.dataset.limitOverview = JSON.stringify(next);

      paintLimitMeter(banner, copy, next);
      evaluate();
    },
    markReached: () => {
      overview = assumeReached(overview);
      banner.dataset.limitOverview = JSON.stringify(overview);

      paintLimitMeter(banner, copy, overview);
      evaluate();
    },
  };
};
