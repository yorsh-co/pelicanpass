import { REDEEMABLE_ITEMS, isRedemptionItem } from './pass.ts';
import { parseAttendeeFilters } from './attendee-filters.ts';

import type { RedemptionItem } from './pass.ts';

/**
 * The administrator's redemption corrections, and how the redemptions list is
 * narrowed.
 *
 * Imported by the server and by the browser bundle, so it carries values only —
 * no Node APIs, and no `config/env.ts`.
 *
 * The volunteer's own outcomes stay in `pass.ts` as `REDEMPTION_OUTCOMES`:
 * `/staff` types itself on that set, and a correction is not something a
 * volunteer can record.
 */

/** What an administrator can do to one item's redemption. */
export const REDEMPTION_CORRECTIONS = ['mark', 'revert'] as const;

export type RedemptionCorrection = (typeof REDEMPTION_CORRECTIONS)[number];

/**
 * Why a correction was made. Snapshotted in the `redemptions.reason` check by
 * migration 027, so a code added here needs a migration too.
 */
export const REDEMPTION_CORRECTION_REASONS = [
  'mis_tap',
  'wrong_attendee',
  'offline',
  'other',
] as const;

export type RedemptionCorrectionReason =
  (typeof REDEMPTION_CORRECTION_REASONS)[number];

/**
 * The reasons each correction admits, in the order the choice lists them.
 *
 * Narrower than the full set on purpose: "handed over while the scanner was
 * down" explains a mark and cannot explain an undo, and "the wrong person" is
 * the other way round.
 */
export const REASONS_FOR: Readonly<
  Record<RedemptionCorrection, readonly RedemptionCorrectionReason[]>
> = {
  mark: ['offline', 'other'],
  revert: ['mis_tap', 'wrong_attendee', 'other'],
};

/**
 * Most rows `redemption_history` returns. Mirrors the `LIMIT` migration 027
 * wrote into the function, so the record page can say when it was reached.
 */
export const REDEMPTION_HISTORY_LIMIT = 200;

/**
 * Whether a value names a correction.
 *
 * @param value - Candidate, typically a route segment.
 */
export const isRedemptionCorrection = (
  value: unknown,
): value is RedemptionCorrection =>
  (REDEMPTION_CORRECTIONS as readonly unknown[]).includes(value);

/**
 * Whether a value is a reason code.
 *
 * @param value - Candidate, typically a request body field.
 */
export const isCorrectionReason = (
  value: unknown,
): value is RedemptionCorrectionReason =>
  (REDEMPTION_CORRECTION_REASONS as readonly unknown[]).includes(value);

/** Items in the order every redemptions screen lists them. */
export const REDEMPTION_ITEM_ORDER = Object.keys(
  REDEEMABLE_ITEMS,
) as RedemptionItem[];

/**
 * Status filter values, in the order the control lists them. Labels are
 * `admin-redemptions.filter.status.*`.
 */
export const REDEMPTION_STATUS_FILTERS = [
  'pending',
  'redeemed',
  'all',
] as const;

export type RedemptionStatusFilter = (typeof REDEMPTION_STATUS_FILTERS)[number];

/** A parsed, settled set of redemptions list filters. */
export interface RedemptionListFilters {
  /** Which item the list is about. Always one: the list is per item. */
  item: RedemptionItem;

  status: RedemptionStatusFilter;

  /** `null` is every attendee, checked in or not. */
  checkedIn: boolean | null;

  /** Free text, trimmed and lowercased. Empty means no search. */
  q: string;

  /** 1-based, clamped to at least 1. */
  page: number;
}

/**
 * Turns a submitted form into redemptions list filters.
 *
 * The search, the presence filter and the page are read by
 * `parseAttendeeFilters`, so they mean exactly what they mean on the roster —
 * the same folding, the same length cap and the same fallbacks. Only the item
 * and the status are this list's own.
 *
 * Unrecognised values fall back to the default rather than erroring, as the
 * roster's do: the first item, and `defaultStatus` for the status, which is
 * every attendee unless the caller says otherwise.
 *
 * @param body - `req.body`, unvalidated. A `GET` has none and yields the
 *   defaults.
 * @param defaultStatus - The status used when the body has none or an
 *   unrecognised one.
 */
export const parseRedemptionFilters = (
  body: unknown,
  defaultStatus: RedemptionStatusFilter = 'all',
): RedemptionListFilters => {
  const fields: Record<string, unknown> =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};

  const { q, checkedIn, page } = parseAttendeeFilters(body);

  const item = typeof fields.item === 'string' ? fields.item : '';
  const status = fields.status;

  return {
    item: isRedemptionItem(item) ? item : 'tshirt',
    status: (REDEMPTION_STATUS_FILTERS as readonly unknown[]).includes(status)
      ? (status as RedemptionStatusFilter)
      : defaultStatus,
    checkedIn,
    q,
    page,
  };
};
