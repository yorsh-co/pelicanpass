import { applyCheckinResponse } from '../state/apply-response.ts';
import { ensureAudience } from '../state/audience.ts';
import { goToStep, handleLockout } from '../ui/navigation.ts';
import { presenceErrorMessage } from '../ui/presence-error.ts';

import api from '../../../../core/api/index.ts';
import utils from '../../../../modules/utils/index.ts';
import stepConfig from '../state/step-config.ts';
import dom from '../dom.ts';
import { logger } from '../../../../modules/log/logger.ts';
import { ApiError } from '../../../../core/api/api.error.ts';
import {
  MIN_PROCESSING_MS,
  PRESENCE_RETRY_COOLDOWN_MS,
  SUCCESS_DWELL_MS,
} from '../../../../modules/ui/pacing.ts';

/**
 * Submits a scanned QR code, the final step of a check-in.
 *
 * Anything other than a lockout or an expired session is rethrown: `modules/qr`
 * owns the scanner and is what shows the message and resumes scanning.
 *
 * @param qrCode - Decoded contents of the scanned code.
 */
export const onQrScan = async (qrCode: string): Promise<void> => {
  const scanStartTime = Date.now();

  const step = stepConfig.qr;
  const flow = step.getFlow();
  const copy = step.getCopy();

  try {
    const res = await api.checkin.submitQrCode(qrCode);

    const nextStep = applyCheckinResponse(res);

    await utils.timing.ensureMinimum(scanStartTime, MIN_PROCESSING_MS);

    void flow.success(copy.success);

    await utils.sleep(SUCCESS_DWELL_MS);

    await goToStep(nextStep);
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.code === 'CAPTCHA_REQUIRED' &&
      err.details?.nextStep
    ) {
      await utils.timing.ensureMinimum(scanStartTime, MIN_PROCESSING_MS);

      await handleLockout(err);

      return;
    }

    // The session expired while the scanner sat open; check-in restarts it and
    // explains why.
    if (err instanceof ApiError && err.code === 'UNAUTHORIZED') {
      await utils.timing.ensureMinimum(scanStartTime, MIN_PROCESSING_MS);

      window.location.href = `/checkin?error=UNAUTHORIZED&audience=${encodeURIComponent(ensureAudience())}`;

      return;
    }
    throw err; // let modules/qr.ts handle message + scanner.resume()
  }
};

/**
 * Asks the server whether a volunteer has marked the attendee present, and
 * moves on to the pass if so.
 *
 * The way through for an attendee whose camera cannot scan the venue's code.
 * Ignored while a check is running or the button is cooling down. Until staff
 * confirm, the answer is `NOT_MARKED_PRESENT`: it is shown in the hint area and
 * the button stays disabled for {@link PRESENCE_RETRY_COOLDOWN_MS}, since each
 * such answer counts toward the step's attempt limit. Any other failure is
 * shown and the button is released at once.
 *
 * The camera cannot be running here: the button is hidden in camera mode, and
 * the step flow disables the camera button for the duration of the request.
 */
export const onPresenceCheck = async (): Promise<void> => {
  const btn = dom.qr.presenceBtn;

  if (btn.disabled) return;

  const checkStartTime = Date.now();

  const step = stepConfig.qr;
  const flow = step.getFlow();
  const copy = step.getCopy();

  btn.disabled = true;
  btn.classList.add('loading');
  void flow.processing();

  try {
    const res = await api.checkin.checkPresence();

    const nextStep = applyCheckinResponse(res);

    await utils.timing.ensureMinimum(checkStartTime, MIN_PROCESSING_MS);

    void flow.success(copy.success);

    await utils.sleep(SUCCESS_DWELL_MS);

    await goToStep(nextStep);
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.code === 'CAPTCHA_REQUIRED' &&
      err.details?.nextStep
    ) {
      await utils.timing.ensureMinimum(checkStartTime, MIN_PROCESSING_MS);

      await handleLockout(err);

      return;
    }

    if (err instanceof ApiError && err.code === 'UNAUTHORIZED') {
      await utils.timing.ensureMinimum(checkStartTime, MIN_PROCESSING_MS);

      window.location.href = `/checkin?error=UNAUTHORIZED&audience=${encodeURIComponent(ensureAudience())}`;

      return;
    }

    const notYet = err instanceof ApiError && err.code === 'NOT_MARKED_PRESENT';

    if (!notYet) {
      logger.warn('step', 'presence check failed', { err });
    }

    await utils.timing.ensureMinimum(checkStartTime, MIN_PROCESSING_MS);

    btn.classList.remove('loading');

    void flow.error(presenceErrorMessage(copy, err));

    if (notYet) {
      await utils.sleep(PRESENCE_RETRY_COOLDOWN_MS);
    }

    btn.disabled = false;
  }
};
