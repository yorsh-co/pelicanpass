import {
  REASONS_FOR,
  REDEMPTION_ITEM_ORDER,
  isCorrectionReason,
} from '../../constants/redemptions.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';
import { readStringField } from '../../shared/utils/request-body.ts';

import type {
  RedemptionCorrection,
  RedemptionCorrectionReason,
} from '../../constants/redemptions.ts';
import type { RedemptionItem } from '../../constants/pass.ts';
import type { AdminRefusal } from '../../types/admin-refusal.ts';
import type { ItemOptions } from './admin.item-options.ts';

/**
 * The rules an administrator's redemption correction is held to, and the
 * shape of the redemptions summary.
 *
 * **Pure, and must stay so**, like `admin.attendees.rules.ts`: the repository
 * calls {@link decideCorrection} inside its transaction, holding the row lock,
 * and the tests call it with nothing but values.
 */

/** A parsed correction request body. */
export interface CorrectionRequest {
  reason: RedemptionCorrectionReason;

  /**
   * The collection time the operator's screen showed, for a revert; `null` for
   * a mark, which has nothing to compare against.
   */
  expectedRedeemedAt: Date | null;
}

/** One item's state on one attendee, as locked for a correction. */
export interface ItemState {
  archived: boolean;

  /** What they registered for, or `null` if they are not entitled. */
  entitlement: string | null;

  redeemedAt: Date | null;
}

/** Every refusal {@link decideCorrection} can reach. */
export type CorrectionRefusal = Extract<
  AdminRefusal,
  | 'attendeeArchived'
  | 'itemAlreadyRedeemed'
  | 'itemNotEntitled'
  | 'itemNotRedeemed'
  | 'redemptionChanged'
>;

/** Counts for one item, or for one of its options. */
export interface SummaryCounts {
  expected: number;
  redeemed: number;

  /** Entitled, not collected, and checked in: can reach the counter now. */
  pendingPresent: number;

  /** Entitled, not collected, and not checked in. */
  pendingAbsent: number;

  /** `redeemed / expected`, or `null` when nobody is entitled. */
  share: number | null;
}

/** One item on the summary, with its per-option breakdown. */
export interface ItemSummary extends SummaryCounts {
  item: RedemptionItem;
  options: (SummaryCounts & { option: string })[];
}

/** One row of `redemptionSummary`, before it is shaped. */
export interface SummaryRow {
  item: RedemptionItem;

  /** The option this row counts, or `null` on the item's total row. */
  option: string | null;

  /** Whether this is the item's total rather than one option's. */
  isTotal: boolean;

  expected: number;
  redeemed: number;
  pendingPresent: number;
  pendingAbsent: number;
}

/**
 * Reads a correction's body.
 *
 * The reason must be one the correction admits, not merely a known code: an
 * undo filed as "handed over offline" would make the audit row say something
 * that cannot have happened.
 *
 * @param correction - Which correction the route names.
 * @param body - The parsed JSON body, unvalidated.
 * @throws {ValidationError} With `reasonInvalid` for a missing or inadmissible
 *   reason; without a reason for a revert whose timestamp is absent or
 *   malformed, which only a client out of step with this server sends.
 */
export const parseCorrection = (
  correction: RedemptionCorrection,
  body: unknown,
): CorrectionRequest => {
  const reason = readStringField(body, 'reason');

  if (
    !isCorrectionReason(reason) ||
    !REASONS_FOR[correction].includes(reason)
  ) {
    throw new ValidationError('Invalid correction reason', {
      reason: 'reasonInvalid',
    });
  }

  if (correction === 'mark') return { reason, expectedRedeemedAt: null };

  const raw = readStringField(body, 'expectedRedeemedAt');
  const expectedRedeemedAt = raw === undefined ? null : new Date(raw);

  if (!expectedRedeemedAt || Number.isNaN(expectedRedeemedAt.getTime())) {
    throw new ValidationError('Invalid expected redemption time');
  }

  return { reason, expectedRedeemedAt };
};

/**
 * Decides whether a correction may be applied to an item as it stands.
 *
 * The revert's timestamp comparison is the optimistic check that keeps a stale
 * screen from undoing a collection it never saw: undone in one tab, collected
 * again at the counter, then undone again from a second tab still showing the
 * first collection. Compared in milliseconds on both sides — Postgres stores
 * microseconds, and the driver and the client both truncate to the same
 * millisecond, so the comparison stays exact.
 *
 * @param state - The item's state, read under the row lock.
 * @param correction - What the operator asked for.
 * @param expectedRedeemedAt - What the operator's screen showed, for a revert.
 * @returns `'apply'`, or the refusal to report.
 */
export const decideCorrection = (
  state: ItemState,
  correction: RedemptionCorrection,
  expectedRedeemedAt: Date | null,
): 'apply' | CorrectionRefusal => {
  if (state.archived) return 'attendeeArchived';

  if (correction === 'mark') {
    if (state.entitlement === null) return 'itemNotEntitled';

    if (state.redeemedAt !== null) return 'itemAlreadyRedeemed';

    return 'apply';
  }

  if (state.redeemedAt === null) return 'itemNotRedeemed';

  if (expectedRedeemedAt?.getTime() !== state.redeemedAt.getTime()) {
    return 'redemptionChanged';
  }

  return 'apply';
};

/**
 * Adds the share to a set of counts.
 *
 * @param counts - One total or one option's row.
 */
const withShare = ({
  expected,
  redeemed,
  pendingPresent,
  pendingAbsent,
}: Omit<SummaryRow, 'item' | 'option' | 'isTotal'>): SummaryCounts => ({
  expected,
  redeemed,
  pendingPresent,
  pendingAbsent,
  share: expected > 0 ? redeemed / expected : null,
});

/**
 * Shapes the summary rows for the screen.
 *
 * Every item is listed, in screen order, including one nobody is entitled to:
 * a missing card would read as a broken panel rather than as "nobody has
 * lunch". Options follow the approved list's order, which is the order the
 * stock is laid out in; a value no longer on the list sorts after it.
 *
 * @param rows - `redemptionSummary`'s rows.
 * @param order - The approved options, for ordering the breakdown.
 */
export const summaryView = (
  rows: readonly SummaryRow[],
  order: ItemOptions,
): ItemSummary[] =>
  REDEMPTION_ITEM_ORDER.map((item) => {
    const own = rows.filter((row) => row.item === item);
    const total = own.find((row) => row.isTotal);

    const rank = (value: string): number => {
      const index = order[item].indexOf(value);

      return index === -1 ? order[item].length : index;
    };

    const options = own
      .filter(
        (row): row is SummaryRow & { option: string } =>
          !row.isTotal && row.option !== null,
      )
      .sort(
        (a, b) =>
          rank(a.option) - rank(b.option) ||
          a.option.localeCompare(b.option, 'pt-BR'),
      )
      .map((row) => ({ option: row.option, ...withShare(row) }));

    return {
      item,
      ...withShare(
        total ?? {
          expected: 0,
          redeemed: 0,
          pendingPresent: 0,
          pendingAbsent: 0,
        },
      ),
      options,
    };
  });
