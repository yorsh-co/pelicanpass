import { request } from './api.request.ts';

/**
 * The volunteer quick lookup's one write, also sent by the attendee editor.
 *
 * There is no read here, and that is not an omission: the search and the record
 * page are server-rendered from the query string, so the only thing this
 * surface sends over the wire is a change. It is also what keeps a volunteer
 * looking people up all evening outside `adminSessionLimiter`'s 20 requests per
 * 60 seconds.
 */

/** What confirming a presence answers with. */
export interface MarkedPresent {
  /** The arrival number, or `null` — volunteers are not issued one. */
  checkinNumber: number | null;

  /** ISO string: it was a `Date` before it was serialised. */
  checkinAt: string;

  /** Whether the attendee was already present before the call. */
  alreadyCheckedIn: boolean;
}

/** The response envelope, with everything optional — see api.raffle.ts. */
interface Envelope<T> {
  data?: Partial<T>;
}

/**
 * Completes an attendee's check-in on their behalf.
 *
 * Stands in for the poster scan when a camera will not cooperate. Safe to call
 * twice: the server locks the row and returns the number it already issued
 * rather than drawing a second.
 *
 * **No `json` option, and none may be added.** The endpoint takes no body, and
 * passing one would set `Content-Type: application/json` —
 * `requireSupportedContentType` calls `req.is()`, which reports false for a
 * request carrying no body *regardless* of the type it declares, so the header
 * turns this into a 415. Measured on the editor's `DELETE`; the same trap.
 *
 * @param attendeeId - Attendee to admit.
 * @returns Their number, the time, and whether they were already present.
 * @throws {ApiError} `CONFLICT` when the attendee is archived,
 *   `CHECKIN_NOT_OPEN` before their audience's window opens, `FORBIDDEN`
 *   without `checkin:write`.
 */
export const markPresent = async (
  attendeeId: string,
): Promise<MarkedPresent> => {
  const res = await request<Envelope<MarkedPresent>>(
    `/api/v1/admin/lookup/${attendeeId}/checkin`,
    { method: 'POST' },
  );

  const data = res.data;

  return {
    checkinNumber: data?.checkinNumber ?? null,
    checkinAt: data?.checkinAt ?? '',
    alreadyCheckedIn: data?.alreadyCheckedIn ?? false,
  };
};
