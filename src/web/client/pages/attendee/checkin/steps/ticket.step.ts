import store from '../state/store.ts';
import stepConfig from '../state/step-config.ts';
import { applyCheckinResponse } from '../state/apply-response.ts';
import { goToStep } from '../ui/navigation.ts';
import {
  formatTicket,
  isValidTicketCode,
  TICKET_CODE_LENGTH,
} from '../../../../../../constants/ticket.ts';

import api from '../../../../core/api/index.ts';
import utils from '../../../../modules/utils/index.ts';
import { getAudienceCopy } from '../ui/messages.ts';
import { logger } from '../../../../modules/log/logger.ts';
import { ApiError } from '../../../../core/api/api.error.ts';
import {
  MIN_PROCESSING_MS,
  SUCCESS_DWELL_MS,
} from '../../../../modules/ui/pacing.ts';

let isSubmitting = false;

/**
 * Submits the ticket code, the first step of a check-in.
 *
 * @param options.fromPaste - The value arrived by paste rather than by typing,
 *   which suppresses the "empty" complaint and sharpens the invalid message.
 * @param options.captchaToken - Supplied when the caller already holds a token.
 */
export const onTicketInput = async (
  options: { fromPaste?: boolean; captchaToken?: string } = {},
): Promise<void> => {
  if (isSubmitting) return;

  const { fromPaste = false } = options;
  let { captchaToken } = options;

  const inputStartTime = Date.now();

  const step = stepConfig.ticket;
  const flow = step.getFlow();
  const copy = step.getCopy();

  const { captchaRequired } = store.getState();
  if (captchaRequired && !captchaToken) {
    const captcha = step.captcha;
    const captchaCopy = getAudienceCopy().captcha;

    captchaToken = captcha.getToken();

    if (!captchaToken) {
      logger.error('ticket input', 'missing captcha');

      void flow.error(captchaCopy.missing);
      return;
    }

    if (captcha.isExpired()) {
      logger.error('ticket input', 'captcha expired');

      void flow.error(captchaCopy.expired);

      captcha.reset();

      return;
    }
  }

  const input = step.input;

  const value = formatTicket(input.value);
  input.value = value;

  if (!value) {
    if (!fromPaste) {
      logger.error('ticket input', 'empty');
      void flow.error(copy.empty);
    }
    return;
  }

  if (!isValidTicketCode(value)) {
    logger.error('ticket input', 'invalid');

    const msg =
      fromPaste && value.length === TICKET_CODE_LENGTH
        ? copy.invalidCode
        : copy.invalidFormat;
    void flow.error(msg);
    return;
  }

  try {
    isSubmitting = true;

    void flow.processing(copy.processing);

    const res = await api.checkin.submitTicket(value, captchaToken);

    const nextStep = applyCheckinResponse(res);

    await utils.timing.ensureMinimum(inputStartTime, MIN_PROCESSING_MS);

    void flow.success(copy.success);

    await utils.sleep(SUCCESS_DWELL_MS);

    await goToStep(nextStep, { skeleton: false });
  } catch (err) {
    await utils.timing.ensureMinimum(inputStartTime, MIN_PROCESSING_MS);

    const code = err instanceof ApiError ? err.code : undefined;

    if (code === 'CAPTCHA_REQUIRED') {
      store.setState({ captchaRequired: true });

      const captcha = step.captcha;
      if (!captcha.widgetId) {
        captcha.render();
      } else {
        captcha.reset();
      }
    }

    void flow.error((code ? copy.error[code] : undefined) ?? copy.unknownError);
  } finally {
    isSubmitting = false;
  }
};
