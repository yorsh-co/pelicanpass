import { ITEM_OPTIONS } from './admin.item-options.ts';
import {
  correctRedemption,
  redemptionSummary,
} from './admin.redemptions.repository.ts';
import { summaryView } from './admin.redemptions.rules.ts';

import type { Request } from 'express';

import type { RedemptionCorrection } from '../../constants/redemptions.ts';
import type { RedemptionItem } from '../../constants/pass.ts';
import type { AdminSession } from '../../types/session.ts';
import type { CorrectionResult } from './admin.redemptions.repository.ts';
import type {
  CorrectionRequest,
  ItemSummary,
} from './admin.redemptions.rules.ts';

/** What the summary endpoint and the first paint both serve. */
export interface RedemptionSummary {
  generatedAt: Date;
  items: ItemSummary[];
}

/**
 * Builds the redemptions summary.
 *
 * A function rather than a method: it needs no session, and the rendered page
 * and the poll endpoint call it the same way, so the first paint and the first
 * refresh cannot disagree — the arrangement `buildSnapshot` has on the metrics
 * panel.
 */
export const buildRedemptionSummary = async (): Promise<RedemptionSummary> => ({
  generatedAt: new Date(),
  items: summaryView(await redemptionSummary(), ITEM_OPTIONS),
});

/**
 * An administrator's corrections to what the counter recorded.
 *
 * A separate service from `AdminLookupService` and `AdminAttendeesService`,
 * for the reason each of those gives about the other: it is gated on its own
 * scope, `redemptions:write`, at its own mount.
 */
export class AdminRedemptionsService {
  readonly req: Request;

  /**
   * @param req - Request carrying an already-gated admin session.
   */
  constructor(req: Request) {
    this.req = req;
  }

  /**
   * The administrator the correction is recorded against.
   *
   * @throws {Error} If the request carries no admin session. Every route that
   *   builds this service sits behind `requireSessionType('admin')`, so this
   *   reports a wiring mistake — and the audit row cannot be written without
   *   an actor.
   */
  get adminId(): string {
    const session = this.req.session as AdminSession | undefined;

    if (!session?.adminId) {
      throw new Error('AdminRedemptionsService requires an admin session');
    }

    return session.adminId;
  }

  /**
   * Marks an item collected, or undoes a collection, and records who did it.
   *
   * @param attendeeId - Attendee whose item is corrected.
   * @param item - Which item.
   * @param correction - Mark or revert.
   * @param request - The parsed reason and expected timestamp.
   * @returns The item's new state.
   */
  async correct(
    attendeeId: string,
    item: RedemptionItem,
    correction: RedemptionCorrection,
    request: CorrectionRequest,
  ): Promise<CorrectionResult> {
    const adminId = this.adminId;

    const result = await correctRedemption({
      attendeeId,
      item,
      correction,
      reason: request.reason,
      adminId,
      expectedRedeemedAt: request.expectedRedeemedAt,
    });

    this.req.log.info(
      { adminId, attendeeId, item, correction, reason: request.reason },
      'Redemption corrected',
    );

    return result;
  }
}
