import utils from '../../../../modules/utils/index.ts';
import ui from '../../../../modules/ui/index.ts';

/**
 * Swaps one step for another.
 *
 * This used to lock, measure and animate the container's height around the
 * swap. That existed because the steps lived inside a fixed-width card that
 * grew and shrank with its contents; the shell now fills the viewport, so
 * there is no height left to animate and the whole measure/await/release dance
 * went with it.
 *
 * The outgoing step is also marked `inert`. Hidden steps are only faded out,
 * not removed from flow, so without it every step's inputs and buttons stayed
 * in the tab order and the accessibility tree at once.
 *
 * @param nextStep - Step to show.
 * @param currentStep - Step to hide, if any.
 */
export const transitionStep = async (
  nextStep: HTMLElement,
  currentStep: HTMLElement | null = null,
): Promise<void> => {
  if (nextStep === currentStep) return;

  if (currentStep) {
    ui.element.setShow(currentStep, false);
    currentStep.inert = true;
  }

  ui.element.setShow(nextStep, true);
  nextStep.inert = false;

  // `setShow` toggles on the frame after next, so the caller's `onEnter` would
  // otherwise focus a step the browser has not laid out yet.
  await utils.timing.waitForNextPaint();

  // Only on a real step change. The first call comes from `init()` with no
  // previous step — the attendee has just arrived, nothing changed, and pulling
  // focus off the top of the document on load is not an announcement.
  if (currentStep) moveFocusToStep(nextStep);
};

/**
 * Sends focus to the new step's heading.
 *
 * Steps swap without a navigation, so without this a screen reader is given no
 * signal that anything happened — the old step simply stops existing and the
 * new one is never announced.
 *
 * The heading rather than the input, deliberately: `ui/flow` focuses inputs on
 * desktop only, because doing so on a phone summons the on-screen keyboard over
 * the content. A heading announces the step and leaves the keyboard closed.
 *
 * @param step - The step now shown.
 */
const moveFocusToStep = (step: HTMLElement): void => {
  const heading = step.querySelector<HTMLElement>('.step-question');

  // `preventScroll` because the shell already positions the step; letting the
  // browser scroll to the heading fights the layout on a short viewport.
  heading?.focus({ preventScroll: true });
};
