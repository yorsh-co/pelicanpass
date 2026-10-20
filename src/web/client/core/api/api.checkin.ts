import { request } from './api.request.ts';

import type { CheckinApiResponse } from './api.types.ts';

/**
 * Submits a ticket code, the first step of a check-in.
 *
 * @param ticket - The attendee's ticket code.
 * @param captchaToken - Turnstile token, required once the server has asked
 *   for one after repeated failures.
 */
export const submitTicket = async (
  ticket: string,
  captchaToken?: string,
): Promise<CheckinApiResponse> =>
  request<CheckinApiResponse>('/api/v1/checkin/ticket', {
    method: 'POST',
    json: { ticket, captchaToken },
  });

/**
 * Deadline for the verification step, twice the default.
 *
 * Success here rotates the session, and the new cookie arrives with the
 * answer. A verification that succeeds after the client stopped waiting loses
 * that cookie and leaves the browser holding the session rotation destroyed,
 * so the attendee starts again at the ticket step. A longer wait makes that
 * rarer; the step reloads after a timeout to recover from it.
 */
const VERIFICATION_TIMEOUT_MS = 30_000;

/** Submits the last four digits of the attendee's phone number. */
export const submitVerification = async (
  verificationCode: string,
): Promise<CheckinApiResponse> =>
  request<CheckinApiResponse>('/api/v1/checkin/verification', {
    method: 'POST',
    json: { verificationCode },
    timeoutMs: VERIFICATION_TIMEOUT_MS,
  });

/** Submits a scanned QR code, the final step of a check-in. */
export const submitQrCode = async (
  qrCode: string,
): Promise<CheckinApiResponse> =>
  request<CheckinApiResponse>('/api/v1/checkin/qr', {
    method: 'POST',
    json: { qrCode },
  });

/** Discards the in-progress check-in and returns to the ticket step. */
export const reset = async (): Promise<CheckinApiResponse> =>
  request<CheckinApiResponse>('/api/v1/checkin/reset', {
    method: 'POST',
  });

/**
 * Asks whether a volunteer has marked the attendee present on the staff
 * screen, and completes the check-in if so.
 *
 * The alternative to scanning for an attendee whose camera does not work.
 * Rejects with `NOT_MARKED_PRESENT` until staff have confirmed them, and each
 * such answer counts toward the QR step's attempt limit.
 */
export const checkPresence = async (): Promise<CheckinApiResponse> =>
  request<CheckinApiResponse>('/api/v1/checkin/presence', {
    method: 'POST',
  });
