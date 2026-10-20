import api from '../../../../core/api/index.ts';
import toast from '../../../../modules/ui/toast.ts';
import { ApiError } from '../../../../core/api/api.error.ts';
import { logger } from '../../../../modules/log/logger.ts';
import { readDoorCopy } from './messages.ts';
import { refusalMessage } from '../../shared/refusal.ts';
import { paintLimitMeter } from '../../shared/limit-meter.ts';
import { parseOverview } from '../../shared/ticket-limit.ts';

import type {
  TicketLimitMode,
  TicketLimitOverview,
  TicketLimitScope,
} from '../../../../../../types/ticket-limit.ts';

/**
 * The roster's ticket limit panel, for every administrator the route showed it
 * to. Only holders of `attendees:limit` get the Edit button and the form; for
 * everyone else the script paints the status and wires nothing.
 *
 * The server renders the panel from the overview and leaves that overview on
 * the section as JSON. This script paints from the same JSON on load and again
 * from the overview a save answers with, through one function, so the panel
 * never has two ways of being right. Like the door panel it redraws in place:
 * the page may have been rendered by a POST, so it cannot simply reload.
 */

/** Reads the checked radio of a group, or `undefined` when none is. */
const checkedValue = (
  form: HTMLFormElement,
  name: string,
): string | undefined =>
  form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;

/**
 * Wires the ticket limit panel: paints it from the overview on the section and,
 * when the server rendered the edit controls, wires editing.
 */
export const setupLimit = (): void => {
  const panel = document.querySelector<HTMLElement>('[data-limit]');
  const form = panel?.querySelector<HTMLFormElement>('[data-limit-form]');
  const editButton =
    panel?.querySelector<HTMLButtonElement>('[data-limit-edit]');
  const initial = parseOverview(panel?.dataset.limitOverview);

  if (!panel || !initial) return;

  const copy = readDoorCopy();
  const status = panel.querySelector<HTMLElement>('[data-limit-status]');
  const mode = panel.querySelector<HTMLElement>('[data-limit-mode]');
  const offLine = panel.querySelector<HTMLElement>('[data-limit-off]');
  const doorHint = panel.querySelector<HTMLElement>('[data-limit-door-hint]');
  const error = panel.querySelector<HTMLElement>('[data-limit-error]');
  const cap = form?.querySelector<HTMLInputElement>('input[name="limit-cap"]');
  const modeGroup = form?.querySelector<HTMLFieldSetElement>(
    '[data-limit-mode-group]',
  );
  const save = form?.querySelector<HTMLButtonElement>('[data-limit-save]');
  const cancel = form?.querySelector<HTMLButtonElement>('[data-limit-cancel]');

  let current = initial;

  /** Greys the cap and the mode while the chosen scope is `off`. */
  const syncDisabled = (): void => {
    if (!form) return;

    const off = checkedValue(form, 'limit-scope') === 'off';

    if (cap) cap.disabled = off;
    if (modeGroup) modeGroup.disabled = off;
  };

  /** Puts the form's fields back to the overview's values. */
  const fill = (overview: TicketLimitOverview): void => {
    if (!form) return;

    for (const radio of form.querySelectorAll<HTMLInputElement>(
      'input[name="limit-scope"]',
    )) {
      radio.checked = radio.value === overview.scope;
    }

    for (const radio of form.querySelectorAll<HTMLInputElement>(
      'input[name="limit-mode"]',
    )) {
      radio.checked = radio.value === overview.mode;
    }

    if (cap) cap.value = overview.cap === null ? '' : String(overview.cap);

    syncDisabled();
  };

  /** The one writer of the panel after the server's first render. */
  const render = (overview: TicketLimitOverview): void => {
    current = overview;
    panel.dataset.limitOverview = JSON.stringify(overview);

    const on = overview.status !== 'off';

    if (status) {
      status.textContent = copy.limitStatus({ status: overview.status });
      status.dataset.status = overview.status;
    }

    if (mode) {
      mode.hidden = !on;
      mode.textContent = copy.limitMode({ mode: overview.mode });
    }

    if (offLine) offLine.hidden = on;
    if (doorHint) doorHint.hidden = overview.scope !== 'door';

    paintLimitMeter(panel, copy, overview);
    fill(overview);
  };

  render(initial);

  if (!form || !editButton) return;

  const setOpen = (open: boolean): void => {
    form.hidden = !open;
    editButton.setAttribute('aria-expanded', String(open));
    editButton.hidden = open;

    if (error) error.hidden = true;
  };

  const report = (err: unknown): void => {
    if (!error) return;

    if (err instanceof ApiError) {
      if (err.code === 'UNAUTHORIZED') {
        window.location.assign('/admin/login');

        return;
      }

      if (err.code === 'FORBIDDEN') {
        error.textContent = copy.limitForbidden();
        error.hidden = false;

        return;
      }
    }

    logger.warn(
      'admin',
      err instanceof Error ? err.message : 'Ticket limit failed',
    );

    error.textContent =
      err instanceof ApiError
        ? (refusalMessage(err) ?? copy.limitFailed())
        : copy.limitFailed();
    error.hidden = false;
  };

  editButton.addEventListener('click', () => {
    fill(current);
    setOpen(true);

    form
      .querySelector<HTMLInputElement>('input[name="limit-scope"]:checked')
      ?.focus();
  });

  cancel?.addEventListener('click', () => {
    fill(current);
    setOpen(false);
    editButton.focus();
  });

  for (const radio of form.querySelectorAll<HTMLInputElement>(
    'input[name="limit-scope"]',
  )) {
    radio.addEventListener('change', syncDisabled);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const scope = checkedValue(form, 'limit-scope') as
      TicketLimitScope | undefined;
    const chosenMode = checkedValue(form, 'limit-mode') as
      TicketLimitMode | undefined;
    const typed = cap?.value.trim() ?? '';

    // Sent as typed: the server owns the bounds and answers a bad cap with a
    // refusal that names them. An empty field is `null`, which only an `off`
    // scope accepts.
    const capValue = typed === '' ? null : Number(typed);

    if (!scope || !chosenMode) return;

    if (save) save.disabled = true;
    if (error) error.hidden = true;

    api.admin.ticketLimit
      .setLimit({ scope, cap: capValue, mode: chosenMode })
      .then((overview) => {
        render(overview);
        setOpen(false);
        editButton.focus();

        void toast.success(copy.limitSaved());
      })
      .catch(report)
      .finally(() => {
        if (save) save.disabled = false;
      });
  });
};
