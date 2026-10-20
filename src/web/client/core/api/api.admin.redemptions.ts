import { request } from './api.request.ts';

import type {
  RedemptionCorrection,
  RedemptionCorrectionReason,
} from '../../../../constants/redemptions.ts';
import type { RedemptionItem } from '../../../../constants/pass.ts';

/**
 * The redemptions screen's poll and its two corrections.
 *
 * The list and the record are server-rendered from a submitted form, so they
 * are not here: the only reads over the wire are the totals' refresh.
 */

/** Counts for one item, or for one of its options. */
export interface RedemptionCounts {
  expected: number;
  redeemed: number;
  pendingPresent: number;
  pendingAbsent: number;

  /** `redeemed / expected`, or `null` when nobody is entitled. */
  share: number | null;
}

/** One item on the summary. */
export interface ItemSummary extends RedemptionCounts {
  item: RedemptionItem;
  options: (RedemptionCounts & { option: string })[];
}

/** What the totals poll answers with. */
export interface RedemptionSummary {
  /** ISO string: it was a `Date` before it was serialised. */
  generatedAt: string;
  items: ItemSummary[];
}

/** What a correction answers with. */
export interface CorrectionResult {
  item: RedemptionItem;

  /** ISO string after a mark, `null` after a revert. */
  redeemedAt: string | null;
}

/** The response envelope, with everything optional — see api.raffle.ts. */
interface Envelope<T> {
  data?: Partial<T>;
}

/**
 * Fetches the per-item totals.
 *
 * @returns The summary, or `null` when the response lacked one — the poll loop
 *   counts that as a failed refresh rather than painting nothing.
 */
export const summary = async (): Promise<RedemptionSummary | null> => {
  const res = await request<Envelope<RedemptionSummary>>(
    '/api/v1/admin/redemptions/summary',
  );

  const data = res.data;

  if (typeof data?.generatedAt !== 'string' || !Array.isArray(data.items)) {
    return null;
  }

  return { generatedAt: data.generatedAt, items: data.items };
};

/**
 * Applies one correction.
 *
 * @param attendeeId - Attendee whose item is corrected.
 * @param item - Which item.
 * @param correction - Mark or revert.
 * @param reason - Why, from the reasons the correction admits.
 * @param expectedRedeemedAt - For a revert, the collection time the page
 *   showed, exactly as it was rendered.
 * @returns The item's new state.
 * @throws {ApiError} `CONFLICT` with a `details.reason` when the correction no
 *   longer applies, `VALIDATION_ERROR` for a missing reason, `FORBIDDEN`
 *   without `redemptions:write`.
 */
export const correct = async (
  attendeeId: string,
  item: RedemptionItem,
  correction: RedemptionCorrection,
  reason: RedemptionCorrectionReason,
  expectedRedeemedAt: string | null,
): Promise<CorrectionResult> => {
  const res = await request<Envelope<CorrectionResult>>(
    `/api/v1/admin/redemptions/${attendeeId}/${item}/${correction}`,
    { method: 'POST', json: { reason, expectedRedeemedAt } },
  );

  if (typeof res.data?.item !== 'string') {
    throw new Error('Correction returned no item');
  }

  return { item: res.data.item, redeemedAt: res.data.redeemedAt ?? null };
};
