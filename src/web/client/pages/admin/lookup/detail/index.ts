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
 * The record page's one interactive control: confirming a presence by hand.
 *
 * Everything else on this screen works without it. The search is a form the
 * browser submits, the pager is a link, and the verification code sits behind a
 * `details` element the browser opens on its own — so a bundle that fails to
 * load costs the volunteer the button and nothing else.
 *
 * There is **one** button on this page, unlike the roster's many, so the armed
 * state is a boolean rather than a tracked element. Copying that file's
 * "arming one disarms the others" machinery would be carrying a solution to a
 * problem this page does not have.
 */

/** Deferred-toast key for a presence confirmed on this page. */
const MARKED_TOAST = 'lookup:marked';

/** How long an armed button waits before it forgets it was clicked. */
const ARM_TIMEOUT_MS = 4000;

let armed = false;
let armedTimer: number | undefined;

/**
 * Asks before the tab is closed or reloaded while the button is armed. A click
 * that would leave is cancelled by the document handler instead, since iOS
 * never shows the prompt.
 */
const unloadGuard = createUnloadGuard();

/**
 * Puts the button back to its resting label.
 *
 * **The label changes and the icon never does.** `docs/infrastructure/asset-delivery.md` names
 * exactly four places an icon can come from and calls the set "closed and
 * statically provable"; swapping a ligature here would make this file a fifth
 * and cost that claim.
 *
 * @param button - Control to disarm.
 */
const disarm = (button: HTMLButtonElement): void => {
  const label = button.querySelector('.btn-label');

  if (label) label.textContent = RECORD_COPY.mark;

  button.classList.remove('is-armed');

  armed = false;
  window.clearTimeout(armedTimer);
  unloadGuard.release();
};

/**
 * Asks for a second click before admitting somebody.
 *
 * A two-step button rather than a native `confirm()` or a modal, matching the
 * roster's archive control. This one is worth the extra tap for a different
 * reason than that one: a confirmation draws a number from a sequence, and the
 * screen offers no way to take it back.
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

/**
 * Puts a refusal where the volunteer is looking, or acts on it.
 *
 * `CONFLICT`, `NOT_FOUND` and `VALIDATION_ERROR` are shown by their reason:
 * one `CONFLICT` code covers more than one refusal, and `details.reason` tells
 * them apart.
 *
 * **`CHECKIN_NOT_OPEN` is the exception and must not be echoed.**
 * `CheckinNotOpenError` carries `'Check-in is not open yet'` — English, because
 * every other consumer is the attendee's browser, which branches on the code
 * and renders its own copy. This screen is pt-BR, so it does the same.
 *
 * @param err - Whatever the request threw.
 * @param slot - The page's error line.
 */
const reportError = (err: unknown, slot: HTMLElement | null): void => {
  if (err instanceof ApiError) {
    if (err.code === 'UNAUTHORIZED') {
      // The session died while the page sat open on a phone in a pocket, which
      // ADMIN_SESSION_TTL makes likely over a long event.
      window.location.assign('/admin/login');

      return;
    }

    if (err.code === 'CHECKIN_NOT_OPEN') {
      if (slot) slot.textContent = RECORD_COPY.notOpen;

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

  logger.warn('admin', err instanceof Error ? err.message : 'Mark failed');

  if (slot) slot.textContent = RECORD_COPY.failed;
};

/**
 * Confirms the presence, then renders the record again from the server.
 *
 * **Re-submitted, not reloaded.** This page is rendered by a `POST` — the
 * attendee ID travels in a body so it never reaches the browser's history — and
 * reloading one raises the browser's resubmission prompt. Submitting the same
 * hidden form is the identical request without the dialog. `location.reload()`
 * is the fallback for a page whose form is missing, which would mean the
 * template and this module had drifted.
 *
 * **The confirmation is deferred, not shown.** The navigation would destroy a
 * toast within milliseconds, so the key is handed to the page it lands on,
 * which shows it over the updated record.
 *
 * @param button - The control that was confirmed.
 */
const submit = async (button: HTMLButtonElement): Promise<void> => {
  const attendeeId = button.dataset.lookupMark;
  const slot = document.querySelector<HTMLElement>('[data-lookup-error]');

  // Confirmed, so leaving is no longer losing anything. Released before the
  // navigation below, which would otherwise prompt for this very action.
  unloadGuard.release();

  if (!attendeeId) return;

  button.disabled = true;

  if (slot) slot.textContent = '';

  try {
    await api.admin.lookup.markPresent(attendeeId);

    deferToast(MARKED_TOAST);

    const record = document.querySelector<HTMLFormElement>('#record');

    if (record) record.requestSubmit();
    else window.location.reload();
  } catch (err) {
    button.disabled = false;

    disarm(button);

    reportError(err, slot);
  }
};

/** Wires the confirm control, if this record has one. */
const setupMarkButton = (): void => {
  const button =
    document.querySelector<HTMLButtonElement>('[data-lookup-mark]');

  // Absent for a read-only operator, an archived record, and anybody who is
  // already present. Returning quietly is cheaper than a module that throws.
  if (!button) return;

  button.addEventListener('click', () => {
    if (armed) {
      void submit(button);

      return;
    }

    arm(button);
  });

  // A click elsewhere puts the button back. One that would leave the page is
  // cancelled and says so: the volunteer taps again to leave.
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
 * Recovers from an expired edge challenge without the resubmission dialog.
 *
 * Same reasoning as {@link submit}, and for the same reason: this page is
 * rendered by a `POST`, so the gate's default reload would raise the browser's
 * resubmission prompt — with somebody standing at the door. Re-submitting
 * `#record` is a top-level navigation, so it still mints a fresh `cf_clearance`,
 * and it lands back on the same record rather than on a blank search.
 */
setChallengeRecovery(() => {
  const record = document.querySelector<HTMLFormElement>('#record');

  if (record) record.requestSubmit();
  else window.location.reload();
});

setupMarkButton();

if (takeDeferredToast() === MARKED_TOAST) {
  void toast.success(RECORD_COPY.marked);
}
