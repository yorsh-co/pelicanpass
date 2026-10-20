import { transitionStep } from './step.ts';
import { setProgressStep } from './progress.ts';

import stepConfig from '../state/step-config.ts';
import store from '../state/store.ts';

import toast from '../../../../modules/ui/toast.ts';
import { getAudienceCopy } from './messages.ts';
import { logger } from '../../../../modules/log/logger.ts';

import type { ApiError } from '../../../../core/api/api.error.ts';
import type { CheckinStep } from '../../../../../../types/checkin.ts';
import type { StepConfigByKey } from '../types.ts';

/**
 * Moves the page to another step: runs the current step's exit, animates the
 * swap, records the new step, then runs its entry.
 *
 * Silently refuses a step it does not know or a transition the current step
 * does not list as reachable — the server chooses the next step, and this is
 * where a stale or unexpected choice is contained.
 *
 * @param nextStepKey - Step to move to.
 * @param options.skeleton - Render the step's placeholder rather than its
 *   content, used while the data behind it is still loading.
 */
export const goToStep = async (
  nextStepKey: CheckinStep,
  options: { skeleton?: boolean } = {},
): Promise<void> => {
  const { skeleton = false } = options;

  const { currentUiStepKey } = store.getState();
  logger.debug(
    'ui',
    `loading ${skeleton ? 'skeleton' : 'hydrated'} ${nextStepKey} step from ${currentUiStepKey ?? 'init'}`,
  );

  const isSameStep = currentUiStepKey === nextStepKey;

  if (isSameStep && skeleton) {
    logger.warn('ui', `${nextStepKey} step is already open`);
    return;
  }

  const steps: StepConfigByKey = stepConfig;

  const nextStep = steps[nextStepKey];
  const currentStep = currentUiStepKey ? steps[currentUiStepKey] : null;

  if (!nextStep) {
    logger.warn('ui', `invalid step: ${nextStepKey}`);
    return;
  }

  if (currentStep && !isSameStep && !currentStep.next?.includes(nextStepKey)) {
    logger.warn(
      'ui',
      `invalid transition: ${currentUiStepKey ?? 'init'} --> ${nextStepKey}`,
    );
    return;
  }

  if (currentStep?.onExit) {
    await currentStep.onExit();
  }

  await transitionStep(nextStep.step, currentStep?.step ?? null);

  store.setState({ currentUiStepKey: nextStepKey, isSkeleton: skeleton });

  // Drives the footer's "Sair" and the progress indicator, both of which read
  // the step straight off the body rather than keeping their own copy.
  document.body.dataset.step = nextStepKey;

  setProgressStep(nextStepKey);

  if (nextStep.onEnter) {
    await nextStep.onEnter(store.getState(), { skeleton });
  }
};

/**
 * Handles a CAPTCHA_REQUIRED lockout: resets local state,
 * shows a toast, and navigates to the server-specified step.
 *
 * @param err - The lockout error. Its `details.nextStep` is what the caller
 *   checked before deciding this was a lockout.
 */
export const handleLockout = async (err: ApiError): Promise<void> => {
  const nextStep = err.details?.nextStep;

  if (!nextStep) {
    logger.warn('ui', 'lockout carried no next step');
    return;
  }

  store.setState({
    captchaRequired: err.details.captchaRequired ?? null,
    session: {},
  });

  const copy = getAudienceCopy().lockout;

  void toast.warn(copy.rateLimit);

  await goToStep(nextStep, { skeleton: false });
};
