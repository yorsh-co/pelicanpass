import { getAttendeeForEdit } from './admin.attendees.repository.ts';

import { redeemItem } from '../attendee/attendee.repository.ts';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error.ts';

import type { Request } from 'express';

import type { AdminSession } from '../../types/session.ts';
import type { RedemptionOutcome } from '../../constants/pass.ts';

/**
 * Handing out a T-shirt from the admin desk.
 *
 * A separate service from {@link AdminRedemptionsService}, which corrects the
 * record under `redemptions:write` and requires a reason. This is the ordinary
 * hand-over, done by an administrator instead of a volunteer scanning a QR, and
 * it records through the same {@link redeemItem} as `/staff` — so the row is
 * indistinguishable from a volunteer's except for `actor_type = 'admin'`.
 *
 * The item is pinned to `tshirt`. `tshirt_volunteer` is never reachable here.
 *
 * Messages are pt-BR on the client; the errors carry a refusal code instead.
 */

/** What {@link AdminTshirtsService.redeem} answers with. */
export interface TshirtRedeemResult {
  /** Whether this call handed the shirt over, or it had already gone. */
  outcome: Extract<RedemptionOutcome, 'redeemed' | 'duplicate'>;

  /** When the shirt was collected — the original time, on a duplicate. */
  redeemedAt: Date;

  /** The size the attendee registered for, for the desk to confirm aloud. */
  size: string;
}

/**
 * Maps what {@link redeemItem} recorded onto the desk's answer.
 *
 * Pure so the mapping is testable without a database. `not_entitled` is a
 * refusal rather than a result: the desk has nothing to show for it except the
 * reason.
 *
 * @param outcome - What `redeemItem` recorded.
 * @param redeemedAt - The collection time it reported, if any.
 * @param size - The attendee's registered size.
 * @returns The response payload.
 * @throws {ConflictError} If the attendee has no shirt to collect.
 */
export const tshirtRedeemResult = (
  outcome: RedemptionOutcome,
  redeemedAt: Date | null,
  size: string | null,
): TshirtRedeemResult => {
  if (outcome === 'redeemed' || outcome === 'duplicate') {
    if (redeemedAt && size) {
      return { outcome, redeemedAt, size };
    }
  }

  throw new ConflictError('Attendee is not entitled to a T-shirt', {
    reason: 'itemNotEntitled',
  });
};

/** The T-shirt desk's one privileged action, behind `tshirt:redeem`. */
export class AdminTshirtsService {
  readonly req: Request;

  /**
   * @param req - Request carrying an already-gated admin session.
   */
  constructor(req: Request) {
    this.req = req;
  }

  /**
   * The administrator the hand-over is recorded against.
   *
   * @throws {Error} If there is no admin session. The route is mounted behind
   *   the session gate, so this reports a wiring mistake — and the audit row
   *   cannot be written without an actor.
   */
  get adminId(): string {
    const session = this.req.session as AdminSession | undefined;

    if (!session?.adminId) {
      throw new Error('AdminTshirtsService requires an admin session');
    }

    return session.adminId;
  }

  /**
   * Hands an attendee their T-shirt, or reports that it already went.
   *
   * Check-in is not required. **Attempts are audited even when refused**: for
   * an attendee with no shirt, `redeemItem` records `not_entitled` before this
   * throws the 409, exactly as `/staff` does, so a cluster of refusals stays
   * visible.
   *
   * @param attendeeId - Attendee collecting.
   * @returns The outcome, when it happened and the size handed over.
   * @throws {NotFoundError} If no attendee under this event holds that ID.
   * @throws {ConflictError} If the attendee is archived or has no T-shirt.
   */
  async redeem(attendeeId: string): Promise<TshirtRedeemResult> {
    const adminId = this.adminId;

    const attendee = await getAttendeeForEdit(attendeeId);

    if (!attendee) {
      throw new NotFoundError('Attendee not found', {
        reason: 'attendeeNotFound',
      });
    }

    // getAttendeeForEdit does not filter archived rows, and redeemItem
    // deliberately does not either, so the refusal belongs here.
    if (attendee.archived_at !== null) {
      throw new ConflictError('Attendee is archived', {
        reason: 'attendeeArchived',
      });
    }

    const { outcome, redeemedAt } = await redeemItem(
      attendeeId,
      'tshirt',
      adminId,
      'admin',
    );

    this.req.log.info(
      { adminId, attendeeId, outcome },
      'T-shirt redeemed at desk',
    );

    return tshirtRedeemResult(outcome, redeemedAt, attendee.tshirt_size);
  }
}
