import dom from '../dom.ts';
import store from '../state/store.ts';

import utils from '../../../../modules/utils/index.ts';
import ui from '../../../../modules/ui/index.ts';
import stepConfig from '../state/step-config.ts';
import { logger } from '../../../../modules/log/logger.ts';
import {
  SUCCESS_CONFIRM_MS,
  SUCCESS_HANDOFF_MS,
} from '../../../../modules/ui/pacing.ts';

/**
 * First name of the attendee being checked in, from the masked preview.
 *
 * @returns The first name, or an empty string when there is no preview.
 */
const previewFirstName = (): string => {
  const name = store.getState().session?.attendeePreview?.name;

  return name?.trim().split(' ')[0] ?? '';
};

/**
 * Fills the card with the attendee's pass details.
 */
const renderCard = (): void => {
  const copy = stepConfig.success.getCopy();
  const firstName = previewFirstName();

  dom.success.greeting.textContent = firstName
    ? copy.greeting(firstName)
    : copy.greetingFallback;

  const { checkinNumber } = store.getState().session ?? {};

  if (typeof checkinNumber !== 'number') return;

  dom.success.checkinNumber.textContent = `#${String(checkinNumber)}`;
  dom.success.numberBlock.hidden = false;
};

/**
 * Plays the confirmation sequence and hands the attendee off to the pass.
 */
export const runSuccessFlow = async (): Promise<void> => {
  const successMessage = dom.success.message;
  const hintDiv = dom.success.hint;
  const copy = stepConfig.success.getCopy();

  renderCard();

  void ui.hint.change(successMessage, copy.success);
  // lib.dom declares vibrate as always present; iOS Safari does not implement
  // it at all, so the optional call is load-bearing rather than defensive.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  navigator.vibrate?.(50);
  await utils.sleep(SUCCESS_CONFIRM_MS);

  void ui.hint.change(successMessage, copy.redirect);
  await utils.sleep(SUCCESS_HANDOFF_MS);

  setTimeout(() => {
    ui.element.setShow(hintDiv, true);
  }, 2000);

  logger.info('success', 'redirecting...');

  window.location.href = '/';
};
