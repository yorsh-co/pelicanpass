import {
  ConflictError,
  NotMarkedPresentError,
} from '../../shared/errors/app-error.ts';

import type { CheckinProgress, CheckinStep } from '../../types/checkin.ts';
import type { CheckinSession } from '../../types/session.ts';

/**
 * Applies a completed step to a check-in session.
 *
 * The nested objects are merged rather than replaced, so a partial `ticket` or
 * `qr` payload does not drop what an earlier step wrote. `currentStep` is
 * recomputed from the resulting progress rather than maintained by callers.
 *
 * The `qr` step is marked cleared after the `ticket` and `verification` steps
 * when the payload reports the attendee already checked in, so a confirmation
 * recorded in between does not send them to scan the poster.
 *
 * @param session - Session to advance.
 * @param step - Step that has just been cleared.
 * @param payload - Fields to merge into the session.
 * @returns A new session; the input is not mutated.
 * @throws {ConflictError} If the step is not reachable from the current state.
 */
export const applyStep = (
  session: CheckinSession,
  step: CheckinStep,
  payload: Partial<CheckinSession> = {},
): CheckinSession => {
  const progress = session.progress;

  validateStep(session, step);

  const now = Date.now();

  const updated: CheckinSession = {
    ...session,
    ...payload,

    progress: { ...progress },

    ticket: { ...session.ticket, ...payload.ticket },
    verification: { ...session.verification, ...payload.verification },
    qr: { ...session.qr, ...payload.qr },

    updatedAt: now,
  };

  switch (step) {
    case 'ticket': {
      updated.progress.ticket = true;
      updated.ticket.timestamp = now;

      // if the attendee already checked in, set the qr step to true so it is skipped
      if (updated.checkinComplete && !updated.progress.qr) {
        updated.progress.qr = true;
      }
      break;
    }
    case 'verification': {
      updated.progress.verified = true;
      updated.verification.timestamp = now;

      // if a volunteer marked the attendee present since the ticket step, skip the qr step
      if (updated.checkinComplete && !updated.progress.qr) {
        updated.progress.qr = true;
      }
      break;
    }
    case 'qr': {
      updated.progress.qr = true;
      updated.qr.timestamp = now;
      break;
    }
  }

  updated.currentStep = getNextStep(updated.progress);

  return updated;
};

/**
 * Applies a volunteer's check-in confirmation to a session waiting on the QR
 * step, clearing that step.
 *
 * @param session - Session to advance.
 * @param checkinComplete - Whether the attendee is marked present in the
 *   database.
 * @returns A new session; the input is not mutated.
 * @throws {NotMarkedPresentError} If the attendee has not been confirmed yet.
 * @throws {ConflictError} If the session has not been verified.
 */
export const applyPresence = (
  session: CheckinSession,
  checkinComplete: boolean,
): CheckinSession => {
  if (!checkinComplete) throw new NotMarkedPresentError();

  return applyStep(session, 'qr', { checkinComplete: true });
};

/**
 * Guards the ordering of the check-in flow.
 *
 * @param session - Session the step is being applied to.
 * @param step - Step being attempted.
 * @throws {ConflictError} If an earlier step has not been cleared.
 */
export const validateStep = (
  session: CheckinSession,
  step: CheckinStep,
): void => {
  switch (step) {
    case 'ticket': {
      return;
    }

    case 'verification': {
      if (!session.progress.ticket) {
        throw new ConflictError('Cannot verify without a validated ticket');
      }
      return;
    }

    case 'qr': {
      // The `source !== 'qr'` exemption is load-bearing: entry via /checkin?k=
      // applies this step at init, before there is anything to verify, so
      // requiring progress.verified here would break poster-scan entry. The
      // token is public either way — see validateQrToken on why this is a flow
      // step rather than a control.
      if (!session.progress.verified && session.source !== 'qr') {
        throw new ConflictError('QR scan requires a verified ticket');
      }
      return;
    }

    default: {
      return;
    }
  }
};

/**
 * Resolves the next step an attendee has to complete.
 *
 * @param progress - Steps cleared so far.
 * @returns The next incomplete step, or `success` when none remain.
 */
export const getNextStep = (progress: CheckinProgress): CheckinStep => {
  if (!progress.ticket) return 'ticket';
  if (!progress.verified) return 'verification';
  if (!progress.qr) return 'qr';
  return 'success';
};

/**
 * Reports whether every check-in step has been cleared.
 *
 * @param progress - Steps cleared so far.
 */
export const isComplete = (progress: CheckinProgress): boolean => {
  return progress.ticket && progress.verified && progress.qr;
};
