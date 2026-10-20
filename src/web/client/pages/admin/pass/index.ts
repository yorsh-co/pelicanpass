import api from '../../../core/api/index.ts';
import toast, {
  deferToast,
  takeDeferredToast,
} from '../../../modules/ui/toast.ts';
import { ApiError } from '../../../core/api/api.error.ts';
import { logger } from '../../../modules/log/logger.ts';
import {
  createUnloadGuard,
  stopLeaving,
} from '../../../modules/ui/unload-guard.ts';
import {
  WELCOME_CUSTOM_PHASE,
  isWelcomeLinePhase,
} from '../../../../../constants/pass.ts';
import { PASS_ADMIN_COPY } from './messages.ts';
import { leaveNotConfirmedMessage, refusalMessage } from '../shared/refusal.ts';

import type { WelcomeScheduleRow } from '../../../core/api/api.admin.pass.ts';

/**
 * The pass screen: editing the welcome schedule, and handing it back to `.env`.
 *
 * Rows are added and removed here and sent whole; the server sorts them and
 * reads each time in the event's zone. The page reloads once a save lands, so
 * what it then shows is the schedule exactly as the server resolves it. The
 * confirmation is deferred to the reloaded page, since the reload would
 * destroy it.
 */

const SAVED_TOAST = 'pass:saved';
const RESET_TOAST = 'pass:reset';

/** How long the armed reset button waits before it forgets it was pressed. */
const ARM_TIMEOUT_MS = 4000;

/**
 * Says why a save failed, in the form's error line.
 *
 * @param err - Whatever the call threw.
 * @param slot - The form's error line.
 */
const reportError = (err: unknown, slot: HTMLElement): void => {
  if (err instanceof ApiError) {
    if (err.code === 'UNAUTHORIZED') {
      window.location.assign('/admin/login');

      return;
    }

    if (err.code === 'FORBIDDEN') {
      slot.textContent = PASS_ADMIN_COPY.forbidden;
      slot.hidden = false;

      return;
    }
  }

  logger.warn('admin', err instanceof Error ? err.message : 'Request failed');

  slot.textContent =
    err instanceof ApiError
      ? (refusalMessage(err) ?? PASS_ADMIN_COPY.failed)
      : PASS_ADMIN_COPY.failed;
  slot.hidden = false;
};

/**
 * Reads the editor's rows, marking any the server would refuse for a reason
 * the page can see first.
 *
 * A custom row's text is checked trimmed only: the server normalises it, and
 * refuses what normalising leaves empty.
 *
 * @param body - The rows' container.
 * @returns The rows, or the message to show when one needs fixing.
 */
const readRows = (
  body: HTMLElement,
): { rows: WelcomeScheduleRow[] } | { problem: string } => {
  const rows: WelcomeScheduleRow[] = [];
  const inputs: HTMLInputElement[] = [];
  const texts: HTMLInputElement[] = [];

  for (const tr of body.querySelectorAll('[data-pass-welcome="row"]')) {
    const phase = tr.querySelector<HTMLSelectElement>('select[name="phase"]');
    const at = tr.querySelector<HTMLInputElement>('input[name="at"]');
    const text = tr.querySelector<HTMLInputElement>('input[name="text"]');

    if (!phase || !at || !text || !isWelcomeLinePhase(phase.value)) continue;

    at.removeAttribute('aria-invalid');
    text.removeAttribute('aria-invalid');

    if (phase.value === WELCOME_CUSTOM_PHASE) {
      rows.push({ phase: phase.value, text: text.value, at: at.value });
      texts.push(text);
    } else {
      rows.push({ phase: phase.value, at: at.value });
    }

    inputs.push(at);
  }

  const blank = texts.filter((input) => input.value.trim() === '');

  if (blank.length > 0) {
    blank.forEach((input) => {
      input.setAttribute('aria-invalid', 'true');
    });
    blank[0]?.focus();

    return { problem: PASS_ADMIN_COPY.missingText };
  }

  const missing = inputs.filter((input) => input.value === '');

  if (missing.length > 0) {
    missing.forEach((input) => {
      input.setAttribute('aria-invalid', 'true');
    });
    missing[0]?.focus();

    return { problem: PASS_ADMIN_COPY.missingTime };
  }

  const seen = new Map<string, HTMLInputElement>();

  for (const input of inputs) {
    const first = seen.get(input.value);

    if (first) {
      first.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-invalid', 'true');
      input.focus();

      return { problem: PASS_ADMIN_COPY.duplicateTime };
    }

    seen.set(input.value, input);
  }

  return { rows };
};

/**
 * Wires the reset as a two-press button, as the attendee editor's archive is:
 * discarding a saved schedule loses the operator's work, but a dialog is a
 * jarring interruption and a modal a component this screen would not need.
 * A click elsewhere, or Escape, puts the button back. A click that would leave
 * the page is cancelled with a warning and the operator taps again to leave;
 * closing or reloading the tab raises the browser's leave-page prompt, where
 * it shows one (iOS never does).
 *
 * @param button - The reset button.
 * @param confirm - Runs on the second press.
 */
const setupReset = (button: HTMLButtonElement, confirm: () => void): void => {
  const label = button.querySelector('.btn-label');
  const unloadGuard = createUnloadGuard();

  let armed = false;
  let timer: number | undefined;

  const disarm = (): void => {
    armed = false;

    window.clearTimeout(timer);
    unloadGuard.release();

    if (label) label.textContent = PASS_ADMIN_COPY.reset;

    button.classList.remove('is-armed');
  };

  button.addEventListener('click', () => {
    if (armed) {
      disarm();
      confirm();

      return;
    }

    armed = true;
    unloadGuard.hold();

    if (label) label.textContent = PASS_ADMIN_COPY.resetConfirm;

    button.classList.add('is-armed');

    timer = window.setTimeout(disarm, ARM_TIMEOUT_MS);
  });

  document.addEventListener('click', (event) => {
    if (
      !armed ||
      (event.target instanceof Node && button.contains(event.target))
    )
      return;

    if (stopLeaving(event)) void toast.warn(leaveNotConfirmedMessage());

    disarm();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && armed) disarm();
  });
};

const form = document.querySelector<HTMLFormElement>(
  '[data-pass-welcome="form"]',
);
const body = form?.querySelector<HTMLElement>('[data-pass-welcome="rows"]');
const empty = form?.querySelector<HTMLElement>('[data-pass-welcome="empty"]');
const template = form?.querySelector<HTMLTemplateElement>(
  '[data-pass-welcome="template"]',
);
const add = form?.querySelector<HTMLButtonElement>('[data-pass-welcome="add"]');
const reset = form?.querySelector<HTMLButtonElement>(
  '[data-pass-welcome="reset"]',
);
const error = form?.querySelector<HTMLElement>('[data-pass-welcome="error"]');

if (form && body && empty && template && add && error) {
  const revision = Number(form.dataset.revision ?? '0');
  const buttons = [...form.querySelectorAll('button')];

  const syncEmpty = (): void => {
    empty.hidden = body.querySelector('[data-pass-welcome="row"]') !== null;
  };

  /**
   * Sends a save and reloads on success.
   *
   * @param schedule - The rows, or `null` for `.env`.
   * @param toastKey - The confirmation to show once reloaded.
   */
  const send = (
    schedule: WelcomeScheduleRow[] | null,
    toastKey: string,
  ): void => {
    buttons.forEach((button) => (button.disabled = true));
    error.hidden = true;

    api.admin.pass
      .saveWelcomeSchedule(revision, schedule)
      .then(() => {
        deferToast(toastKey);
        window.location.reload();
      })
      .catch((err: unknown) => {
        reportError(err, error);
        buttons.forEach((button) => (button.disabled = false));
      });
  };

  add.addEventListener('click', () => {
    body.append(template.content.cloneNode(true));
    syncEmpty();

    body
      .querySelector<HTMLInputElement>(
        '[data-pass-welcome="row"]:last-child input[name="at"]',
      )
      ?.focus();
  });

  // A custom row's text box shows only while the row is custom. Its value is
  // kept when hidden, so switching back and forth does not lose it.
  body.addEventListener('change', (event) => {
    const phase =
      event.target instanceof HTMLSelectElement && event.target.name === 'phase'
        ? event.target
        : null;
    const text = phase
      ?.closest('[data-pass-welcome="row"]')
      ?.querySelector<HTMLInputElement>('[data-pass-welcome="text"]');

    if (!phase || !text) return;

    text.hidden = phase.value !== WELCOME_CUSTOM_PHASE;

    if (!text.hidden) text.focus();
  });

  body.addEventListener('click', (event) => {
    const remove =
      event.target instanceof Element
        ? event.target.closest('[data-pass-welcome="remove"]')
        : null;

    if (!remove) return;

    remove.closest('[data-pass-welcome="row"]')?.remove();
    syncEmpty();
    add.focus();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const read = readRows(body);

    if ('problem' in read) {
      error.textContent = read.problem;
      error.hidden = false;

      return;
    }

    send(read.rows, SAVED_TOAST);
  });

  if (reset) {
    setupReset(reset, () => {
      send(null, RESET_TOAST);
    });
  }
}

const deferred = takeDeferredToast();

if (deferred === SAVED_TOAST) void toast.success(PASS_ADMIN_COPY.saved);
if (deferred === RESET_TOAST) void toast.success(PASS_ADMIN_COPY.resetDone);
