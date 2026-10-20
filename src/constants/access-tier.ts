/**
 * The access tier a volunteer's pass displays.
 *
 * A display label, not a permission. It summarises what the volunteer's flags
 * and linked administrator account would let them do, so a colleague can tell
 * at a glance what to expect of them. Nothing is authorised by it: every gate —
 * `/staff`, `/raffle`, `/admin` — re-reads Postgres on its own request.
 *
 * WARN: This module is imported by browser code, so it must stay free of Node
 * built-ins and of anything the client tsconfig excludes.
 */

/**
 * Every tier, highest first. The order is the precedence: a volunteer who
 * qualifies for several shows the first one that applies.
 */
export const ACCESS_TIERS = [
  'edit',
  'lookup',
  'tshirt',
  'redeem',
  'raffle',
  'none',
] as const;

/** One access tier. */
export type AccessTier = (typeof ACCESS_TIERS)[number];

/** Narrows an unchecked value to an access tier. */
export const isAccessTier = (value: unknown): value is AccessTier =>
  (ACCESS_TIERS as readonly unknown[]).includes(value);
