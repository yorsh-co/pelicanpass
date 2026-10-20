import store from './store.ts';

import type { CheckinApiResponse } from '../../../../core/api/api.types.ts';
import type { CheckinStep } from '../../../../../../types/checkin.ts';

/**
 * Commits a check-in response to the store and reports where to go next.
 *
 * The server owns the flow, so a response with no `nextStep` is a broken
 * contract rather than a state the page can recover from.
 *
 * @param res - Response from any of the check-in endpoints.
 * @returns The step the server chose.
 * @throws {Error} If the response carries no next step.
 */
export const applyCheckinResponse = (res: CheckinApiResponse): CheckinStep => {
  store.setState({
    captchaRequired: res.meta?.captchaRequired ?? null,
    session: res.data?.session ?? null,
  });

  const nextStep = res.meta?.nextStep;

  if (!nextStep) {
    throw new Error('Missing next step from server');
  }

  return nextStep;
};
