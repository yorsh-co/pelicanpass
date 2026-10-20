import api from '../../../../core/api/index.ts';
import toast, {
  deferToast,
  takeDeferredToast,
} from '../../../../modules/ui/toast.ts';
import { ApiError } from '../../../../core/api/api.error.ts';
import { logger } from '../../../../modules/log/logger.ts';
import { RESYNC_DELAY_MS } from '../../../../modules/ui/pacing.ts';
import utils from '../../../../modules/utils/index.ts';
import { RECORD_COPY } from './messages.ts';
import { setChallengeRecovery } from '../../../../modules/ui/challenge-gate.ts';
import {
  leaveNotConfirmedMessage,
  refusalMessage,
} from '../../shared/refusal.ts';
import {
  createUnloadGuard,
  stopLeaving,
} from '../../../../modules/ui/unload-guard.ts';
import { isRedemptionItem } from '../../../../../../constants/pass.ts';
import {
  isCorrectionReason,
  isRedemptionCorrection,
} from '../../../../../../constants/redemptions.ts';

import type { RedemptionCorrection } from '../../../../../../constants/redemptions.ts';

/**
 * The record page's corrections: mark an item collected, or undo a collection.
 *
 * Each item row carries its own reason choice and button. A correction takes a
 * reason and then a second press, the arm-then-confirm pattern the lookup and
 * the roster use: undoing a collection puts the chip back on somebody's pass,
 * and marking one tells every counter they already have it.
 *
 * Several buttons can be on the page, so the armed one is tracked as an
 * element — arming one disarms any other, unlike the lookup's single button.
 */

/** Deferred-toast keys, one per correction. */
const TOAST_KEYS = {
  mark: 'redemptions:marked',
  revert: 'redemptions:reverted',
} as const satisfies Record<RedemptionCorrection, string>;

/** How long an armed button waits before it forgets it was clicked. */
const ARM_TIMEOUT_MS = 4000;

let armed: HTMLButtonElement | null = null;
let armedTimer: number | undefined;

/**
 * Asks before the tab is closed or reloaded while a button is armed. A click
 * that would leave is cancelled by the document handler instead, since iOS
 * never shows the prompt.
 */
const unloadGuard = createUnloadGuard();

const errorLine = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-redemption-error]');

/**
 * Reads the correction a button carries.
 *
 * @param button - A `data-redemption-action` button.
 */
const correctionOf = (
  button: HTMLButtonElement,
): RedemptionCorrection | null => {
  const value = button.dataset.redemptionAction;

  return isRedemptionCorrection(value) ? value : null;
};

/**
 * The reason choice beside a correction button.
 *
 * @param button - A `data-redemption-action` button.
 */
const reasonSelectOf = (button: HTMLButtonElement): HTMLSelectElement | null =>
  button.parentElement?.querySelector<HTMLSelectElement>(
    '[data-redemption-reason]',
  ) ?? null;

/**
 * Puts a button back to its resting label. The icon-free label is the only
 * thing that changes, for the reason lookup/detail gives about ligatures.
 *
 * @param button - Control to disarm.
 */
const disarm = (button: HTMLButtonElement): void => {
  const correction = correctionOf(button);
  const label = button.querySelector('.btn-label');

  if (label && correction) label.textContent = RECORD_COPY.action[correction];

  button.classList.remove('is-armed');

  if (armed === button) armed = null;

  window.clearTimeout(armedTimer);
  unloadGuard.release();
};

/**
 * Asks for a second press before saving.
 *
 * @param button - Control to arm.
 */
const arm = (button: HTMLButtonElement): void => {
  if (armed && armed !== button) disarm(armed);

  const label = button.querySelector('.btn-label');

  if (label) label.textContent = RECORD_COPY.confirm;

  button.classList.add('is-armed');

  armed = button;
  unloadGuard.hold();

  window.clearTimeout(armedTimer);
  armedTimer = window.setTimeout(() => {
    disarm(button);
  }, ARM_TIMEOUT_MS);
};

/**
 * Puts a failure where the operator is looking, or acts on it.
 *
 * @param err - Whatever the request threw.
 */
const reportError = (err: unknown): void => {
  const slot = errorLine();

  if (err instanceof ApiError) {
    if (err.code === 'UNAUTHORIZED') {
      window.location.assign('/admin/login');

      return;
    }

    if (
      err.code === 'CONFLICT' ||
      err.code === 'NOT_FOUND' ||
      err.code === 'VALIDATION_ERROR'
    ) {
      if (slot) slot.textContent = refusalMessage(err) ?? RECORD_COPY.failed;

      return;
    }

    if (err.code === 'FORBIDDEN') {
      void toast.warn(RECORD_COPY.forbidden);

      return;
    }
  }

  logger.warn(
    'admin',
    err instanceof Error ? err.message : 'Redemption correction failed',
  );

  if (slot) slot.textContent = RECORD_COPY.failed;
};

/**
 * Says a reason is needed, and moves focus to where it is chosen.
 *
 * @param button - The control that was pressed without one.
 */
const askForReason = (button: HTMLButtonElement): void => {
  const slot = errorLine();

  if (slot) slot.textContent = RECORD_COPY.reasonMissing;

  reasonSelectOf(button)?.focus();
};

/** Renders the record again from the server, as lookup/detail does. */
const reloadRecord = (): void => {
  const record = document.querySelector<HTMLFormElement>('#record');

  if (record) record.requestSubmit();
  else window.location.reload();
};

/**
 * Sends a correction, then renders the record again.
 *
 * The reason is read at the moment of sending rather than at arming, so a
 * change of mind between the two presses is what gets recorded.
 *
 * @param button - The confirmed control.
 */
const submit = async (button: HTMLButtonElement): Promise<void> => {
  const correction = correctionOf(button);
  const { item, attendeeId, expectedRedeemedAt } = button.dataset;
  const reason = reasonSelectOf(button)?.value;
  const slot = errorLine();

  disarm(button);

  if (!correction || !attendeeId || !item || !isRedemptionItem(item)) return;

  // Checked before arming too; this covers a reason cleared in between.
  if (!isCorrectionReason(reason)) {
    askForReason(button);

    return;
  }

  button.disabled = true;

  if (slot) slot.textContent = '';

  try {
    await api.admin.redemptions.correct(
      attendeeId,
      item,
      correction,
      reason,
      expectedRedeemedAt ?? null,
    );

    deferToast(TOAST_KEYS[correction]);

    reloadRecord();
  } catch (err) {
    // A timeout leaves the correction unknown, and the record can say which
    // way it went. Read again once the server has had time to finish, rather
    // than report a failure that may not be one.
    if (err instanceof ApiError && err.code === 'EDGE_TIMEOUT') {
      if (slot) slot.textContent = RECORD_COPY.resyncing;

      await utils.sleep(RESYNC_DELAY_MS);

      reloadRecord();

      return;
    }

    button.disabled = false;

    reportError(err);
  }
};

/** Wires every correction control on the page. */
const setupActions = (): void => {
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '[data-redemption-action]',
  );

  // Absent for a read-only operator and an archived record.
  if (buttons.length === 0) return;

  for (const button of buttons) {
    button.addEventListener('click', () => {
      if (armed === button) {
        void submit(button);

        return;
      }

      if (!isCorrectionReason(reasonSelectOf(button)?.value)) {
        askForReason(button);

        return;
      }

      const slot = errorLine();

      if (slot) slot.textContent = '';

      arm(button);
    });
  }

  // A click elsewhere puts the button back. One that would leave the page is
  // cancelled and says so: the operator taps again to leave.
  document.addEventListener('click', (event) => {
    if (
      !armed ||
      (event.target instanceof Node && armed.contains(event.target))
    )
      return;

    if (stopLeaving(event)) void toast.warn(leaveNotConfirmedMessage());

    disarm(armed);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && armed) disarm(armed);
  });
};

/**
 * Recovers from an expired edge challenge by re-submitting the record, for the
 * reason lookup/detail gives: this page is rendered by a `POST`.
 */
setChallengeRecovery(reloadRecord);

setupActions();

const deferred = takeDeferredToast();

if (deferred === TOAST_KEYS.mark) void toast.success(RECORD_COPY.toast.mark);
if (deferred === TOAST_KEYS.revert)
  void toast.success(RECORD_COPY.toast.revert);
