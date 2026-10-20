import { isAdminScope } from '../../constants/admin-scopes.ts';
import { isRedemptionItem } from '../../constants/pass.ts';

import type { AccessTier } from '../../constants/access-tier.ts';
import type { AttendeeRole } from '../../types/attendee.ts';

/** What {@link accessTier} derives a tier from. */
export interface AccessTierInput {
  attendeeRole: AttendeeRole;
  canRedeem: boolean;

  /** Stations as stored; unknown values are ignored. */
  redeemScopes: readonly string[];
  canDraw: boolean;

  /** Scopes of the linked, active administrator; `null` when there is none. */
  adminScopes: readonly string[] | null;
}

/**
 * Derives the tier a volunteer's pass displays. Highest applicable wins:
 * `edit`, `lookup`, `tshirt`, `redeem`, `raffle`, `none`.
 *
 * Redeeming mirrors the `/staff` gate: `can_redeem` with at least one valid
 * station, so an empty or unrecognised scope set does not count. Lookup needs
 * `attendees:read` together with `checkin:write`; read-only access is not
 * lookup. Editing needs `attendees:read` together with `attendees:write`. The
 * T-shirt desk needs `tshirt:redeem`, which on its own opens `/admin/tshirts`.
 *
 * @param input - The volunteer's flags and the scopes of their linked admin.
 * @returns The tier, or `null` for a participant, who has none.
 */
export const accessTier = ({
  attendeeRole,
  canRedeem,
  redeemScopes,
  canDraw,
  adminScopes,
}: AccessTierInput): AccessTier | null => {
  if (attendeeRole !== 'volunteer') return null;

  const held = new Set((adminScopes ?? []).filter(isAdminScope));
  const edit = held.has('attendees:read') && held.has('attendees:write');
  const lookup = held.has('attendees:read') && held.has('checkin:write');
  const tshirt = held.has('tshirt:redeem');
  const redeem = canRedeem && redeemScopes.some(isRedemptionItem);

  if (edit) return 'edit';
  if (lookup) return 'lookup';
  if (tshirt) return 'tshirt';
  if (redeem) return 'redeem';
  if (canDraw) return 'raffle';

  return 'none';
};
