import api from '../../../../core/api/index.ts';
import toast, {
  deferToast,
  takeDeferredToast,
} from '../../../../modules/ui/toast.ts';
import { ApiError } from '../../../../core/api/api.error.ts';
import { logger } from '../../../../modules/log/logger.ts';
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

/**
 * The record page's one interactive control: recording a t-shirt as handed over.
 *
 * Everything else on this screen works without it. The search is a form the
 * browser submits and the verification code sits behind a `details` element the
 * browser opens on its own, so a bundle that fails to load costs the operator
 * the button and nothing else.
 *
 * **The button takes two presses**, as the lookup's does. A hand-over cannot be
 * undone on this screen, and a mis-tap on the wrong record marks somebody
 * else's shirt as collected, so the owner is refused when they come for it.
 * There is one button on the page, so the armed state is a boolean.
 */

/** Deferred-toast key for a hand-over recorded on this page. */
const REDEEMED_TOAST = 'tshirts:redeemed';

/** Deferred-toast key for a hand-over that had already been recorded. */
const DUPLICATE_TOAST = 'tshirts:duplicate';

/** How long an armed button waits before it forgets it was clicked. */
const ARM_TIMEOUT_MS = 4000;

let armed = false;
let armedTimer: number | undefined;

/** Resting label, read from the server-rendered button, which knows the size. */
let restingLabel = '';

/**
 * Asks before the tab is closed or reloaded while the button is armed. A click
 * that would leave is cancelled by the document handler instead, since iOS
 * never shows the prompt.
 */
const unloadGuard = createUnloadGuard();

/** Whether a request is in flight, so a second press cannot send another. */
let inFlight = false;

/**
 * Puts the button back to its resting label.
 *
 * **The label changes and the icon never does**, for the reason
 * lookup/detail gives: `docs/infrastructure/asset-delivery.md` keeps the set of icon sources
 * closed and statically provable.
 *
 * @param button - Control to disarm.
 */
const disarm = (button: HTMLButtonElement): void => {
  const label = button.querySelector('.btn-label');

  if (label) label.textContent = restingLabel;

  button.classList.remove('is-armed');

  armed = false;
  window.clearTimeout(armedTimer);
  unloadGuard.release();
};

/**
 * Asks for a second press before recording the hand-over.
 *
 * @param button - Control to arm.
 */
const arm = (button: HTMLButtonElement): void => {
  const label = button.querySelector('.btn-label');

  if (label) label.textContent = RECORD_COPY.confirm;

  button.classList.add('is-armed');

  armed = true;
  unloadGuard.hold();

  window.clearTimeout(armedTimer);
  armedTimer = window.setTimeout(() => {
    disarm(button);
  }, ARM_TIMEOUT_MS);
};

const errorLine = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-tshirt-error]');

/**
 * Puts a refusal where the operator is looking, or acts on it.
 *
 * `CONFLICT`, `NOT_FOUND` and `VALIDATION_ERROR` are shown by their reason: one
 * `CONFLICT` code covers more than one refusal, and `details.reason` tells them
 * apart.
 *
 * @param err - Whatever the request threw.
 */
const reportError = (err: unknown): void => {
  const slot = errorLine();

  if (err instanceof ApiError) {
    if (err.code === 'UNAUTHORIZED') {
      // The session died while the page sat open, which ADMIN_SESSION_TTL makes
      // likely over a long event.
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

  logger.warn('admin', err instanceof Error ? err.message : 'Redeem failed');

  if (slot) slot.textContent = RECORD_COPY.failed;
};

/**
 * Renders the record again from the server.
 *
 * **Re-submitted, not reloaded.** This page is rendered by a `POST` — the
 * attendee ID travels in a body so it never reaches the browser's history — and
 * reloading one raises the browser's resubmission prompt. Submitting the same
 * hidden form is the identical request without the dialog. `location.reload()`
 * is the fallback for a page whose form is missing, which would mean the
 * template and this module had drifted.
 */
const reloadRecord = (): void => {
  const record = document.querySelector<HTMLFormElement>('#record');

  if (record) record.requestSubmit();
  else window.location.reload();
};

/**
 * Records the hand-over, then renders the record again.
 *
 * **The outcome is deferred, not shown.** The navigation would destroy a toast
 * within milliseconds, so the key is handed to the page it lands on, which
 * shows it over the updated record.
 *
 * @param button - The hand-over control.
 */
const submit = async (button: HTMLButtonElement): Promise<void> => {
  const attendeeId = button.dataset.tshirtRedeem;
  const label = button.querySelector('.btn-label');

  // Confirmed, so leaving is no longer losing anything. Released before the
  // navigation below, which would otherwise prompt for this very action.
  unloadGuard.release();
  window.clearTimeout(armedTimer);
  armed = false;

  if (inFlight || !attendeeId) return;

  inFlight = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');

  if (label) label.textContent = RECORD_COPY.redeeming;

  const slot = errorLine();

  if (slot) slot.textContent = '';

  try {
    const { outcome } = await api.admin.tshirts.redeemTshirt(attendeeId);

    deferToast(outcome === 'duplicate' ? DUPLICATE_TOAST : REDEEMED_TOAST);

    // Left disabled: the record is about to be replaced by one with no button.
    reloadRecord();
  } catch (err) {
    inFlight = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');

    disarm(button);

    reportError(err);
  }
};

/** Wires the hand-over control, if this record has one. */
const setupRedeemButton = (): void => {
  const button = document.querySelector<HTMLButtonElement>(
    '[data-tshirt-redeem]',
  );

  // Absent for a shirt already collected and for an archived record. Returning
  // quietly is cheaper than a module that throws.
  if (!button) return;

  restingLabel = button.querySelector('.btn-label')?.textContent ?? '';

  button.addEventListener('click', () => {
    if (armed) {
      void submit(button);

      return;
    }

    arm(button);
  });

  // A click elsewhere puts the button back. One that would leave the page is
  // cancelled and says so: the operator taps again to leave.
  document.addEventListener('click', (event) => {
    if (
      !armed ||
      (event.target instanceof Node && button.contains(event.target))
    )
      return;

    if (stopLeaving(event)) void toast.warn(leaveNotConfirmedMessage());

    disarm(button);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && armed) disarm(button);
  });
};

/**
 * Recovers from an expired edge challenge without the resubmission dialog, for
 * the reason {@link reloadRecord} gives.
 */
setChallengeRecovery(reloadRecord);

setupRedeemButton();

const deferred = takeDeferredToast();

if (deferred === REDEEMED_TOAST) {
  void toast.success(RECORD_COPY.redeemed);
} else if (deferred === DUPLICATE_TOAST) {
  void toast.warn(RECORD_COPY.duplicate);
}
