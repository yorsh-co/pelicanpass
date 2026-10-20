import { request } from './api.request.ts';

/**
 * Answers as the card sends them, keyed by question id: a rating's number, a
 * yes-or-no's boolean, a text answer's trimmed string. Blank answers are left
 * out.
 */
export type SurveyAnswers = Record<string, number | boolean | string>;

/**
 * Sends the attendee's answers to the questionnaire.
 *
 * @param structureVersion - The version the form was rendered with, so the
 *   server can tell a form built from questions that have since changed.
 * @param answers - The answers.
 * @throws {ApiError} With `SURVEY_ANSWERED` if this attendee already answered,
 *   `SURVEY_STALE` if the questions changed, `SURVEY_CLOSED` if the window
 *   shut, `FORBIDDEN` if their audience has no questionnaire, or
 *   `VALIDATION_ERROR` if the answers do not fit the questions.
 */
export const submit = async (
  structureVersion: string,
  answers: SurveyAnswers,
): Promise<void> => {
  await request('/api/v1/survey', {
    method: 'POST',
    json: { structureVersion, answers },
  });
};
