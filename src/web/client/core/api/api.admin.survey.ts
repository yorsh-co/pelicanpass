import { request } from './api.request.ts';

/**
 * The questionnaire screen's one call. The screen itself, its counts and its
 * downloads are server-rendered and plain links.
 */

/** An administrator's override: forced open or closed, or `null` for the schedule. */
export type SurveyOverride = 'open' | 'closed' | null;

/**
 * Forces the questionnaire open or closed for both audiences, or hands it back
 * to the schedule.
 *
 * @param override - The choice.
 * @throws {ApiError} With `FORBIDDEN` for an administrator without
 *   `survey:write`, or `VALIDATION_ERROR` for a value the server does not
 *   accept.
 */
export const setOverride = async (override: SurveyOverride): Promise<void> => {
  await request('/api/v1/admin/survey/override', {
    method: 'POST',
    json: { override },
  });
};
