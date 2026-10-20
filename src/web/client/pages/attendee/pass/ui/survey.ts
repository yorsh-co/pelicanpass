import { SURVEY_COPY } from './messages.ts';
import { unauthorizedHref } from './live.ts';
import { renderWelcome } from './pass.ts';
import { setupRatings } from './survey-rating.ts';

import api from '../../../../core/api/index.ts';
import { ApiError } from '../../../../core/api/api.error.ts';
import toast, {
  deferToast,
  takeDeferredToast,
} from '../../../../modules/ui/toast.ts';
import ui from '../../../../modules/ui/index.ts';
import { MIN_PROCESSING_MS } from '../../../../modules/ui/pacing.ts';
import { createRetapMarker } from '../../../../modules/ui/retap.ts';
import utils from '../../../../modules/utils/index.ts';
import { logger } from '../../../../modules/log/logger.ts';

import type { AttendeeSurveyState } from '../../../../core/api/api.attendee.ts';
import type { SurveyAnswers } from '../../../../core/api/api.survey.ts';

/**
 * The questionnaire, behind a chip on the pass.
 *
 * The chip (`components/pass.ejs`) shows only while the questionnaire is open
 * and not yet answered; it opens a modal dialog (`components/survey-dialog.ejs`)
 * holding the form. Everything the dialog shows is rendered on the server from
 * the attendee's questions; this reads the form back through its `data-*`
 * attributes and imports no question list. The page renders neither for an
 * audience without a questionnaire, which leaves this with nothing to do.
 */

/** Deferred-toast key for the notice that the questions changed under the form. */
const STALE_TOAST = 'survey:stale';

const chip = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('[data-pass="surveyChip"]');

const dialog = (): HTMLDialogElement | null =>
  document.querySelector<HTMLDialogElement>('[data-pass="survey"]');

const welcomeLine = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-pass="copy-welcome"]');

/**
 * Shows or hides the way in.
 *
 * @param visible - Whether the chip should show.
 */
const showChip = (visible: boolean): void => {
  const el = chip();

  if (el) el.hidden = !visible;
};

/**
 * Closes the dialog and takes the chip away: there is nothing left to open it
 * for. The dialog closes rather than showing a thanks of its own because it
 * sits in the top layer, above the toast that says so. A welcome line pointing
 * at the chip turns to the thanks now rather than on the next poll, which the
 * server settles the same way.
 *
 * @param el - The dialog.
 */
const markDone = (el: HTMLDialogElement): void => {
  el.dataset.state = 'done';
  el.close();
  showChip(false);

  if (welcomeLine()?.dataset.phase === 'survey') renderWelcome('thanks');
};

/**
 * Follows the questionnaire's state as the pass poll reports it.
 *
 * Only the chip moves. A dialog someone is typing in is never closed from
 * here: if the window shuts meanwhile, their submit is refused and that closes
 * it. Once answered, the chip stays gone whatever the poll says.
 *
 * @param survey - The pass payload's `survey`, if it carried a usable one.
 */
export const renderSurveyState = (survey?: AttendeeSurveyState): void => {
  const el = dialog();

  if (!el || !survey || el.dataset.state === 'done') return;

  showChip(survey.open && !survey.completed);
};

/**
 * Reads one question's answer from its wrapper.
 *
 * @param wrapper - Element carrying `data-question-id` and `data-type`.
 * @returns The answer, or `undefined` when it was left blank.
 */
const readAnswer = (
  wrapper: HTMLElement,
): number | boolean | string | undefined => {
  if (wrapper.dataset.type === 'text') {
    const text =
      wrapper.querySelector<HTMLTextAreaElement>('textarea')?.value.trim() ??
      '';

    return text === '' ? undefined : text;
  }

  if (wrapper.dataset.type === 'rating') {
    const value =
      wrapper.querySelector<HTMLInputElement>('input[type="number"]')?.value ??
      '';

    return value === '' ? undefined : Number(value);
  }

  const checked = wrapper.querySelector<HTMLInputElement>(
    'input[type="radio"]:checked',
  );

  return checked ? checked.value === 'yes' : undefined;
};

/**
 * Reads every answered question.
 *
 * @param form - The card's form.
 */
const readAnswers = (form: HTMLFormElement): SurveyAnswers => {
  const answers: SurveyAnswers = {};

  for (const wrapper of form.querySelectorAll<HTMLElement>(
    '[data-question-id]',
  )) {
    const id = wrapper.dataset.questionId;
    const answer = readAnswer(wrapper);

    if (id !== undefined && answer !== undefined) answers[id] = answer;
  }

  return answers;
};

/**
 * Keeps each text answer's counter in step with what has been typed.
 *
 * @param form - The card's form.
 */
const setupCounters = (form: HTMLFormElement): void => {
  for (const wrapper of form.querySelectorAll<HTMLElement>(
    '[data-type="text"]',
  )) {
    const textarea = wrapper.querySelector('textarea');
    const counter = wrapper.querySelector<HTMLElement>(
      '[data-survey="counter"]',
    );
    const max = Number(wrapper.dataset.maxLength);

    if (!textarea || !counter) continue;

    textarea.addEventListener('input', () => {
      counter.textContent = SURVEY_COPY.counter(textarea.value.length, max);
    });
  }
};

/**
 * A submit whose answer never arrived. Its resend is refused `SURVEY_ANSWERED`
 * when the first went through, which this turns back into the thanks it
 * earned.
 */
const submitRetap = createRetapMarker();

/** The marker's key: one questionnaire per pass. */
const SUBMIT_KEY = 'survey';

/**
 * Turns a refused submit into what the attendee sees.
 *
 * A refusal that closes the dialog says so in a toast. One that leaves it open
 * says so in the dialog, since a toast would be painted beneath it. One that
 * reloads hands its toast to the reloaded page.
 *
 * @param el - The dialog.
 * @param error - The dialog's line for a send worth retrying.
 * @param err - What the request threw.
 * @returns Whether the button should be offered again.
 */
const handleRefusal = (
  el: HTMLDialogElement,
  error: HTMLElement,
  err: unknown,
): boolean => {
  const code = err instanceof ApiError ? err.code : undefined;

  // Read on every answer, so the mark lasts one resend at most.
  const retapped = submitRetap.take(SUBMIT_KEY);

  if (code === 'EDGE_TIMEOUT') submitRetap.mark(SUBMIT_KEY);

  switch (code) {
    case 'SURVEY_ANSWERED':
      markDone(el);

      if (retapped) void toast.success(SURVEY_COPY.thanks);
      else void toast.info(SURVEY_COPY.answered);

      return false;
    case 'SURVEY_CLOSED':
      el.close();
      showChip(false);
      void toast.warn(SURVEY_COPY.closed);
      return false;
    case 'SURVEY_STALE':
      deferToast(STALE_TOAST);
      window.location.reload();
      return false;
    case 'FORBIDDEN':
      el.close();
      showChip(false);
      void toast.warn(SURVEY_COPY.unavailable);
      return false;
    case 'UNAUTHORIZED':
      window.location.href = unauthorizedHref();
      return false;
    default:
      logger.warn('survey', 'survey submit failed', { err });
      void ui.hint.showError(error, SURVEY_COPY.failed);
      return true;
  }
};

/**
 * Wires the chip, the dialog, its counters and its submit.
 *
 * `showModal()` rather than `show()`, as for the venue map: the modal form
 * makes the pass behind it inert, closes on Escape and hands focus back to the
 * chip, none of which needs code here. A tap outside the dialog's box closes it
 * too, tested against the box because a tap on the dialog's own padding also
 * reports the dialog as its target.
 *
 * Validation is the browser's own, through `reportValidity`, against the
 * `required` and `maxlength` the form was rendered with. The server checks
 * everything again.
 *
 * The spinner holds for at least {@link MIN_PROCESSING_MS} whatever the
 * outcome: a dialog that closes the instant it is tapped reads as a failure.
 */
export const setupSurvey = (): void => {
  const opener = chip();
  const el = dialog();
  const form = el?.querySelector<HTMLFormElement>('[data-survey="form"]');
  const submit = form?.querySelector<HTMLButtonElement>(
    '[data-survey="submit"]',
  );
  const close = el?.querySelector<HTMLButtonElement>('[data-survey="close"]');
  const error = form?.querySelector<HTMLElement>('[data-survey="error"]');

  if (!opener || !el || !form || !submit || !close || !error) return;

  opener.onclick = () => {
    el.showModal();
  };

  close.onclick = () => {
    el.close();
  };

  el.onclick = (event) => {
    if (event.target !== el) return;

    const box = el.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;

    if (!inside) el.close();
  };

  setupCounters(form);
  setupRatings(form);

  const send = async (): Promise<void> => {
    const startTime = Date.now();

    submit.disabled = true;
    submit.classList.add('loading');
    void ui.hint.clear(error);

    try {
      await api.survey.submit(
        form.dataset.structureVersion ?? '',
        readAnswers(form),
      );
      await utils.timing.ensureMinimum(startTime, MIN_PROCESSING_MS);

      submitRetap.take(SUBMIT_KEY);
      markDone(el);
      void toast.success(SURVEY_COPY.thanks);
    } catch (err) {
      await utils.timing.ensureMinimum(startTime, MIN_PROCESSING_MS);

      submit.disabled = !handleRefusal(el, error, err);
    } finally {
      submit.classList.remove('loading');
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    if (form.reportValidity()) void send();
  });
};

/**
 * Shows the notice a stale submit deferred across its reload, if there is one.
 *
 * Called once the boot screen is gone, since a toast raised under it would be
 * half over before it could be read.
 */
export const showDeferredSurveyToast = (): void => {
  if (takeDeferredToast() === STALE_TOAST) void toast.warn(SURVEY_COPY.stale);
};
