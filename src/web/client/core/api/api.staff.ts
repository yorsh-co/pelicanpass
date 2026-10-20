import { request } from './api.request.ts';

import type { RedemptionItem } from '../../../../constants/pass.ts';

/** How the volunteer's screen names the attendee in front of them. */
export type ServedIdentifier =
  | { kind: 'checkinNumber'; value: number }
  | { kind: 'firstName'; value: string };

/** One item's standing for the attendee under review. */
export interface ServedItem {
  item: RedemptionItem;
  label: string;
  value: string | null;
  redeemedAt: string | null;

  /**
   * Whether this volunteer's station hands this item over. Every item is sent
   * either way — the card stays a complete picture of the attendee, so a
   * volunteer can answer a question about the other table.
   *
   * A display hint, not the control: the server refuses an out-of-scope
   * redemption whatever the button says.
   */
  inScope: boolean;
}

/** What a volunteer sees after a scan or a lookup. */
export interface ReviewView {
  handle: string;
  attendeeRole: 'participant' | 'volunteer';
  identifier: ServedIdentifier;
  items: ServedItem[];
}

/** The band on the volunteer's own screen. */
export interface StaffBand {
  band: { colour: string; word: string };
  expiresInMs: number;
}

/** Outcome of handing one item over. */
export interface RedeemResult {
  outcome: 'redeemed' | 'duplicate' | 'not_entitled';
  item: RedemptionItem;
  label: string;
  redeemedAt: string | null;
}

/**
 * The response envelope, with everything optional.
 *
 * The other API modules do the same: what crosses the wire is a claim about
 * shape, not a guarantee of one, and narrowing here is cheaper than a surprise
 * at a redemption counter.
 */
interface Envelope<T> {
  data?: Partial<T>;
}

/** The band and how long it lasts, for the volunteer's own timer. */
export const getBand = async (): Promise<StaffBand | null> => {
  const res = await request<Envelope<StaffBand>>('/api/v1/staff/band');
  const { band, expiresInMs } = res.data ?? {};

  if (!band?.word || typeof expiresInMs !== 'number') return null;

  return { band, expiresInMs };
};

/** Verifies a scanned pass and opens a review. */
export const verify = async (token: string): Promise<ReviewView> => {
  const res = await request<Envelope<ReviewView>>('/api/v1/staff/verify', {
    method: 'POST',
    json: { token },
  });

  const review = res.data;

  if (!review?.handle || !review.identifier || !review.attendeeRole) {
    throw new Error('Verify returned no review');
  }

  return { ...review, items: review.items ?? [] } as ReviewView;
};

/** Opens a review from a typed check-in number or ticket code. */
export const lookup = async (query: string): Promise<ReviewView> => {
  const res = await request<Envelope<ReviewView>>('/api/v1/staff/lookup', {
    method: 'POST',
    json: { query },
  });

  const review = res.data;

  if (!review?.handle || !review.identifier || !review.attendeeRole) {
    throw new Error('Lookup returned no review');
  }

  return { ...review, items: review.items ?? [] } as ReviewView;
};

/**
 * Records that an item was handed over.
 *
 * Every outcome arrives as a 200 — `duplicate` and `not_entitled` are answers
 * about the attendee, not failures of the request, so they resolve here rather
 * than throwing.
 */
export const redeem = async (
  handle: string,
  item: RedemptionItem,
): Promise<RedeemResult> => {
  const res = await request<Envelope<RedeemResult>>('/api/v1/staff/redeem', {
    method: 'POST',
    json: { handle, item },
  });

  const result = res.data;

  if (!result?.outcome) throw new Error('Redeem returned no outcome');

  return result as RedeemResult;
};
