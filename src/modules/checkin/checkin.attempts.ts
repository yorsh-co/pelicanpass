import type { CheckinFailedAttempts } from '../../types/checkin.ts';
import type { CheckinSession } from '../../types/session.ts';

/**
 * Steps that can fail and therefore carry a counter.
 *
 * Narrower than `CheckinStep`, which also covers `init` and `success` — those
 * are states the flow passes through rather than attempts an attendee can get
 * wrong, so they have neither a counter nor a threshold.
 */
export type FailableStep = keyof CheckinFailedAttempts;

/** Failures per step before the session requires a captcha. */
const LOCKOUT_THRESHOLDS: Record<FailableStep, number> = {
  ticket: 5,
  verification: 5,
  qr: 10,
};

/**
 * Records a failed attempt against a step and raises the captcha flag once
 * that step crosses its threshold.
 *
 * @param session - Session the attempt was made against.
 * @param step - Step that failed.
 * @returns A new session; the input is not mutated.
 */
export const recordFailedAttempt = (
  session: CheckinSession,
  step: FailableStep,
): CheckinSession => {
  const failedAttempts: CheckinFailedAttempts = {
    ...session.failedAttempts,
    [step]: session.failedAttempts[step] + 1,
  };

  const captchaRequired =
    session.captchaRequired || failedAttempts[step] >= LOCKOUT_THRESHOLDS[step];

  return {
    ...session,
    failedAttempts,
    captchaRequired,
    updatedAt: Date.now(),
  };
};

/**
 * Clears the captcha requirement and every failure counter, after an attendee
 * has solved a captcha.
 *
 * @param session - Session to clear.
 * @returns A new session; the input is not mutated.
 */
export const clearCaptchaRequirement = (
  session: CheckinSession,
): CheckinSession => ({
  ...session,
  captchaRequired: false,
  failedAttempts: { ticket: 0, verification: 0, qr: 0 },
  updatedAt: Date.now(),
});
