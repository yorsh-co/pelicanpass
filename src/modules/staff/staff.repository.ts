import { randomUUID } from 'crypto';

import redis from '../../shared/db/redis.ts';
import { hash } from '../../shared/utils/hash.ts';

/**
 * Review handle TTL.
 *
 * The window between a volunteer seeing who they are serving and tapping the
 * item they handed over — long enough to find a t-shirt in the right size and
 * pass it across a table, short enough that a phone left on a counter is not a
 * standing licence to redeem against whoever was last scanned.
 */
const REVIEW_TTL_SECONDS = 120;

/** What a handle represents, once resolved. */
export interface ReviewHandle {
  /** The attendee being served. */
  attendeeId: string;

  /**
   * The volunteer serving them, recorded as `redeemed_by` on the audit row and
   * checked against the session that presents the handle.
   */
  volunteerId: string;
}

/**
 * Builds the Redis key for a review handle.
 *
 * Hashed as the handle is a bearer credential.
 *
 * @param handle - The opaque handle given to the volunteer.
 */
const reviewKey = (handle: string): string => `staff:review:${hash(handle)}`;

/**
 * Mints a handle standing for "this volunteer is serving this attendee".
 *
 * The handle exists so `/redeem` does not have to take a pass token. A
 * pass token would likely expire while the volunteer completes the action.
 *
 * @param review - Who is being served, and by whom.
 * @returns The opaque handle to give the volunteer.
 */
export const mintReviewHandle = async (
  review: ReviewHandle,
): Promise<string> => {
  const handle = randomUUID();

  await redis.set(
    reviewKey(handle),
    JSON.stringify(review),
    'EX',
    REVIEW_TTL_SECONDS,
  );

  return handle;
};

/**
 * Resolves a handle back to the pair it was minted for.
 *
 * Not consumed on read. A volunteer who taps two items for the same attendee
 * should not have to re-scan between them, and the conditional `UPDATE` behind
 * each redemption is what stops the second tap on the *same* item mattering.
 *
 * **Resolution is not authorisation.** The pair says who the handle was minted
 * for, not that whoever presented it is that volunteer. The caller must compare
 * `volunteerId` against the session in hand — without it, a handle that reached
 * a second volunteer writes their action under the first one's name.
 *
 * @param handle - Handle presented by the volunteer.
 * @returns The pair, or `null` if the handle is unknown or has expired.
 */
export const resolveReviewHandle = async (
  handle: string,
): Promise<ReviewHandle | null> => {
  const raw = await redis.get(reviewKey(handle));

  if (!raw) return null;

  return JSON.parse(raw) as ReviewHandle;
};
