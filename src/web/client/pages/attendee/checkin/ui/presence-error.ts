import { ApiError } from '../../../../core/api/api.error.ts';

/**
 * The message to show when the volunteer-confirmation check failed.
 *
 * Only `NOT_MARKED_PRESENT` has copy of its own: it is the expected answer
 * until staff confirm the attendee, and the advice differs from a failure.
 * Lockouts and expired sessions are handled by the caller before this.
 *
 * @param copy - The QR step's copy for the attendee's audience. Declared
 *   structurally: `types.ts` pulls the captcha widget into the test program.
 * @param err - Whatever the request threw.
 */
export const presenceErrorMessage = (
  copy: { presenceNotYet: string; presenceError: string },
  err: unknown,
): string =>
  err instanceof ApiError && err.code === 'NOT_MARKED_PRESENT'
    ? copy.presenceNotYet
    : copy.presenceError;
