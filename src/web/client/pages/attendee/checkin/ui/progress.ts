import { qsOptional } from '../../../../layouts/main/dom.ts';

import type { CheckinStep } from '../../../../../../types/checkin.ts';

/** The three segments the indicator shows, in order. */
const PROGRESS_STEPS = ['ticket', 'verification', 'qr'] as const;

/**
 * Marks which segment of the progress indicator the attendee is on.
 *
 * The fill is CSS's job — it reads `body[data-step]`, which `goToStep` already
 * sets. This only carries what colour cannot: `aria-current`, so a screen
 * reader announces the current step rather than three undifferentiated list
 * items.
 *
 * `success` is not a segment. It leaves every segment complete and none
 * current, which is what finishing looks like.
 *
 * @param step - The step now being shown.
 */
export const setProgressStep = (step: CheckinStep): void => {
  for (const key of PROGRESS_STEPS) {
    const el = qsOptional(`[data-progress="${key}"]`);
    if (!el) continue;

    if (key === step) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
  }
};
