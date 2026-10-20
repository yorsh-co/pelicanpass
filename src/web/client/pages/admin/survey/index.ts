import api from '../../../core/api/index.ts';
import toast, {
  deferToast,
  takeDeferredToast,
} from '../../../modules/ui/toast.ts';
import { ApiError } from '../../../core/api/api.error.ts';
import { logger } from '../../../modules/log/logger.ts';
import { SURVEY_ADMIN_COPY } from './messages.ts';
import { refusalMessage } from '../shared/refusal.ts';

import type { SurveyOverride } from '../../../core/api/api.admin.survey.ts';

/**
 * The questionnaire screen: saving the override.
 *
 * Everything else on the screen is server-rendered, and the page reloads once
 * the override is saved, so what it then shows is the state exactly as the
 * server resolves it rather than a guess made here. The confirmation is
 * deferred to the reloaded page, since the reload would destroy it.
 */

/** Deferred-toast key for a saved override. */
const SAVED_TOAST = 'survey:saved';

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
      slot.textContent = SURVEY_ADMIN_COPY.forbidden;
      slot.hidden = false;

      return;
    }
  }

  logger.warn('admin', err instanceof Error ? err.message : 'Request failed');

  slot.textContent =
    err instanceof ApiError
      ? (refusalMessage(err) ?? SURVEY_ADMIN_COPY.failed)
      : SURVEY_ADMIN_COPY.failed;
  slot.hidden = false;
};

/**
 * Reads the chosen override off the form.
 *
 * @param form - The override form.
 */
const readChoice = (form: HTMLFormElement): SurveyOverride => {
  const value = new FormData(form).get('override');

  return value === 'open' || value === 'closed' ? value : null;
};

const form = document.querySelector<HTMLFormElement>(
  '[data-survey="override"]',
);
const save = form?.querySelector<HTMLButtonElement>('[data-survey="save"]');
const error = form?.querySelector<HTMLElement>('[data-survey="error"]');

if (form && save && error) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();

    save.disabled = true;
    error.hidden = true;

    api.admin.survey
      .setOverride(readChoice(form))
      .then(() => {
        deferToast(SAVED_TOAST);
        window.location.reload();
      })
      .catch((err: unknown) => {
        reportError(err, error);
        save.disabled = false;
      });
  });
}

if (takeDeferredToast() === SAVED_TOAST) {
  void toast.success(SURVEY_ADMIN_COPY.saved);
}
