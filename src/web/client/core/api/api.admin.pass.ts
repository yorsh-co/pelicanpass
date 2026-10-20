import { request } from './api.request.ts';

import type {
  WELCOME_CUSTOM_PHASE,
  WelcomePhase,
} from '../../../../constants/pass.ts';

/**
 * The pass screen's one call. The screen itself is server-rendered and
 * reloads after a save.
 */

/**
 * One row of the editor: from `at`, the pass shows `phase`, or `text` for a
 * custom row.
 */
export type WelcomeScheduleRow = (
  { phase: WelcomePhase } | { phase: typeof WELCOME_CUSTOM_PHASE; text: string }
) & {
  /** Wall time in the event's zone, as a `datetime-local` input holds it. */
  at: string;
};

/**
 * Saves the welcome schedule, or hands it back to `.env`.
 *
 * @param revision - The revision the page was rendered from.
 * @param schedule - The rows, in any order, or `null` for `.env`.
 * @throws {ApiError} With `CONFLICT` and `scheduleChanged` if someone saved
 *   since the page was rendered, `VALIDATION_ERROR` with a `schedule*` reason
 *   for rows the server does not accept, or `FORBIDDEN` for an administrator
 *   without `pass:write`.
 */
export const saveWelcomeSchedule = async (
  revision: number,
  schedule: readonly WelcomeScheduleRow[] | null,
): Promise<void> => {
  await request('/api/v1/admin/pass/welcome-schedule', {
    method: 'PUT',
    json: { revision, schedule },
  });
};
