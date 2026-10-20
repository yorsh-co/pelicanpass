import stepConfig from '../state/step-config.ts';
import { applyCheckinResponse } from '../state/apply-response.ts';
import { ensureAudience } from '../state/audience.ts';
import { goToStep, handleLockout } from '../ui/navigation.ts';
import {
  formatVerificationCode,
  isValidVerificationCode,
} from '../ui/formatters.ts';

import utils from '../../../../modules/utils/index.ts';
import api from '../../../../core/api/index.ts';
import { logger } from '../../../../modules/log/logger.ts';
import { ApiError } from '../../../../core/api/api.error.ts';
import {
  MIN_PROCESSING_MS,
  RESYNC_DELAY_MS,
  SUCCESS_DWELL_MS,
} from '../../../../modules/ui/pacing.ts';

let isSubmitting = false;

/**
 * Submits the last four digits of the attendee's phone number.
 *
 * @param options.fromPaste - The value arrived by paste rather than by typing,
 *   which suppresses the complaint about an empty field.
 */
export const onVerificationInput = async (
  options: { fromPaste?: boolean } = {},
): Promise<void> => {
  if (isSubmitting) return;

  const { fromPaste = false } = options;

  const inputStartTime = Date.now();

  const step = stepConfig.verification;
  const flow = step.getFlow();
  const copy = step.getCopy();

  const input = step.input;

  const value = formatVerificationCode(input.value);
  input.value = value;

  if (!value) {
    if (!fromPaste) {
      logger.error('verification input', 'empty');
      void flow.error(copy.defaultHint);
    }
    return;
  }

  if (!isValidVerificationCode(value)) {
    logger.error('verification input', 'invalid');
    void flow.error(copy.defaultHint);
    return;
  }

  try {
    isSubmitting = true;

    void flow.processing(copy.processing);

    const res = await api.checkin.submitVerification(value);

    const nextStep = applyCheckinResponse(res);

    await utils.timing.ensureMinimum(inputStartTime, MIN_PROCESSING_MS);

    void flow.success(copy.success);

    await utils.sleep(SUCCESS_DWELL_MS);

    await goToStep(nextStep, { skeleton: false });
  } catch (err) {
    await utils.timing.ensureMinimum(inputStartTime, MIN_PROCESSING_MS);

    if (err instanceof ApiError) {
      if (err.code === 'CAPTCHA_REQUIRED' && err.details?.nextStep) {
        await handleLockout(err);

        return;
      }

      // The answer never arrived, so neither did the rotated session cookie if
      // it succeeded. Reloading lets the server render the step this browser is
      // really on: verification again if it never ran, the ticket step if the
      // session was rotated away. Every step is safe to repeat.
      if (err.code === 'EDGE_TIMEOUT') {
        void flow.error(copy.error[err.code] ?? copy.unknownError);

        await utils.sleep(RESYNC_DELAY_MS);

        window.location.reload();
        return;
      }

      // The session expired while the step sat open; check-in restarts it and
      // explains why.
      if (err.code === 'UNAUTHORIZED') {
        window.location.href = `/checkin?error=UNAUTHORIZED&audience=${encodeURIComponent(ensureAudience())}`;
        return;
      }

      void flow.error(copy.error[err.code] ?? copy.unknownError);
      return;
    }

    void flow.error(copy.unknownError);
  } finally {
    isSubmitting = false;
  }
};
