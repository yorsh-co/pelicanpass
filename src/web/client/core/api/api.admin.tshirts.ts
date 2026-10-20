import { request } from './api.request.ts';

/**
 * The t-shirt desk's one write.
 *
 * There is no read here: the search and the record page are server-rendered
 * from a submitted form, so the only thing this surface sends over the wire is
 * a hand-over.
 */

/** What recording a hand-over answers with. */
export interface TshirtRedemption {
  /** `duplicate` when the shirt had already been collected. */
  outcome: 'redeemed' | 'duplicate';

  /** ISO string: it was a `Date` before it was serialised. */
  redeemedAt: string;

  /** The size the attendee ordered. */
  size: string;
}

/** The response envelope, with everything optional — see api.raffle.ts. */
interface Envelope<T> {
  data?: Partial<T>;
}

/**
 * Records an attendee's t-shirt as handed over.
 *
 * Safe to call twice: a shirt already collected is answered as a `duplicate`
 * with the time of the first collection, not refused.
 *
 * **No `json` option, and none may be added.** The endpoint takes no body, and
 * passing one would set `Content-Type: application/json`, which
 * `requireSupportedContentType` turns into a 415 for a request that carries no
 * body — see `markPresent` in api.admin.lookup.ts.
 *
 * @param attendeeId - Attendee collecting the shirt.
 * @returns The outcome, when the shirt was collected, and its size.
 * @throws {ApiError} `CONFLICT` when the attendee is archived or not entitled
 *   to a shirt, `NOT_FOUND` for an unknown attendee, `FORBIDDEN` without
 *   `tshirt:redeem`.
 */
export const redeemTshirt = async (
  attendeeId: string,
): Promise<TshirtRedemption> => {
  const res = await request<Envelope<TshirtRedemption>>(
    `/api/v1/admin/tshirts/${attendeeId}/redeem`,
    { method: 'POST' },
  );

  const data = res.data;

  return {
    outcome: data?.outcome === 'duplicate' ? 'duplicate' : 'redeemed',
    redeemedAt: data?.redeemedAt ?? '',
    size: data?.size ?? '',
  };
};
