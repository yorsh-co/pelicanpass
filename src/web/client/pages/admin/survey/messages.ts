import { createAdminSurveyMessages } from '../../../../../i18n/generated/admin-survey.messages.ts';
import { readMessages } from '../../../core/i18n.ts';

const survey = readMessages('admin-survey', createAdminSurveyMessages);

/**
 * What the questionnaire screen's script writes, read from the `admin-survey`
 * catalog the route inlined. Static text is rendered by `survey/index.ejs`.
 */
export const SURVEY_ADMIN_COPY = {
  saved: survey.overrideSaved(),
  failed: survey.overrideFailed(),
  forbidden: survey.overrideForbidden(),
} as const;
