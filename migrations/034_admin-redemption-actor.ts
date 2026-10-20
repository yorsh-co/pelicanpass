import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Lets an administrator record an ordinary redemption, not only a correction.
 *
 * `027` tied `actor_type` to the outcome: an administrator row always carried a
 * correction outcome (`marked`, `reverted`) and a reason, a volunteer row never
 * did. That was true while an administrator only ever corrected a volunteer's
 * tap. The T-shirt desk changes it: an administrator there hands over a shirt,
 * which is a real handover and not a correction. It is recorded as `redeemed`
 * (or `duplicate`, or `not_entitled`) under `actor_type = 'admin'`, with no
 * reason, so `redemption_metrics` counts it as counter throughput like any
 * other pickup.
 *
 * The replacement check states the two rules separately:
 *
 * - **A correction outcome is always an administrator's, and always has a
 *   reason.** Unchanged from `027`.
 * - **Any other outcome never has a reason**, whoever recorded it. The reason is
 *   a fixed code that explains a correction; an ordinary outcome has nothing to
 *   explain.
 *
 * What stays impossible is the part that mattered: a volunteer row can still
 * never carry a correction outcome or a reason, because a volunteer's tap
 * cannot be anything else. Only the other direction, an administrator row with
 * an ordinary outcome, is newly allowed.
 *
 * Nothing else changes. `redemption_history` (`027`) reads `actor_type`
 * per row and already names an administrator by `admins.username`, whatever the
 * outcome. `redemption_metrics` (`017`) groups by `item` and `outcome` and
 * never reads `actor_type`. No grant changes either: `027` already granted
 * `INSERT (actor_type, reason)`.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/** The outcomes only an administrator records. */
const CORRECTION_OUTCOMES = `('marked', 'reverted')`;

export const up = (pgm: MigrationBuilder): void => {
  // Dropped and re-added in this migration's transaction, as `026` does for the
  // item check, so the table is never briefly unconstrained.
  pgm.dropConstraint('redemptions', 'redemptions_actor_consistency_check');

  pgm.addConstraint('redemptions', 'redemptions_actor_consistency_check', {
    check: `(outcome IN ${CORRECTION_OUTCOMES}) = (reason IS NOT NULL)
      AND (outcome NOT IN ${CORRECTION_OUTCOMES} OR actor_type = 'admin')`,
  });
};

/**
 * Restores `027`'s check, which ties `actor_type` to the outcome one-to-one.
 *
 * **Fails if an administrator has recorded an ordinary outcome**, and that is
 * the intended behaviour, as in `026` and `027`: `redemptions` is append-only,
 * and the restored check refuses those rows rather than leaving rows it says
 * cannot exist. Nothing may edit or delete them to make room.
 */
export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('redemptions', 'redemptions_actor_consistency_check');

  pgm.addConstraint('redemptions', 'redemptions_actor_consistency_check', {
    check: `(outcome IN ${CORRECTION_OUTCOMES}) = (actor_type = 'admin')
      AND (reason IS NOT NULL) = (actor_type = 'admin')`,
  });
};
