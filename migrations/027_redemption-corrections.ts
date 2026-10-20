import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Lets an administrator correct a redemption, and read one attendee's history.
 *
 * Until now every `redemptions` row was a volunteer's tap. A correction — an
 * undo after a mis-tap, or an item handed out while a scanner was down — is a
 * different actor doing a different thing, so it is recorded as such rather
 * than disguised as a tap:
 *
 * - `actor_type` says who `redeemed_by` names. It defaults to `volunteer`, which
 *   is exactly what every existing row is, so the backfill is the default.
 * - `marked` and `reverted` are the two correction outcomes. They are kept apart
 *   from `redeemed` so `redemption_metrics` still counts counter throughput.
 * - `reason` is a fixed code, never free text, so no personal data can reach an
 *   append-only table that nothing is allowed to edit.
 *
 * The consistency check ties the three together: an administrator row always
 * carries a correction outcome and a reason, and a volunteer row never does.
 *
 * **History is a function, not a grant.** `009` withholds `SELECT` on this table
 * from the application role, and `017` gave the dashboard counts through a
 * migrator-owned view rather than widening that. `redemption_history` follows
 * the same reasoning one step further: it answers for one attendee per call, so
 * the table stays unreadable in bulk while a dispute at the counter can still be
 * settled. It runs with the migrator's rights (`SECURITY DEFINER`), and pins its
 * `search_path` so a caller cannot shadow the tables it reads.
 *
 * The constraint snapshots are hardcoded, for the reason `014` gives.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/** Every outcome `redemptions.outcome` admits, as of this migration. */
const OUTCOMES = `('redeemed', 'duplicate', 'not_entitled', 'marked', 'reverted')`;

/** The volunteer-only set this migration replaces, for `down`. */
const PREVIOUS_OUTCOMES = `('redeemed', 'duplicate', 'not_entitled')`;

/** The outcomes only an administrator records. */
const CORRECTION_OUTCOMES = `('marked', 'reverted')`;

/** Every reason code a correction may carry. */
const REASONS = `('mis_tap', 'wrong_attendee', 'offline', 'other')`;

/**
 * Reads the application role name from the environment.
 *
 * Duplicated from `005_app-role-grants.ts` rather than imported: a migration is
 * a snapshot that has to keep running unchanged, so it does not depend on
 * another migration's internals.
 *
 * @returns The validated role name.
 * @throws {Error} If the variable is unset or is not a bare identifier.
 */
const appRole = (): string => {
  const role = process.env.POSTGRES_USER;

  if (!role) {
    throw new Error(
      'POSTGRES_USER must be set: it names the role these grants apply to',
    );
  }

  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`POSTGRES_USER is not a bare SQL identifier: ${role}`);
  }

  return role;
};

export const up = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.addColumn('redemptions', {
    actor_type: {
      type: 'text',
      notNull: true,
      default: 'volunteer',
      check: "actor_type IN ('volunteer', 'admin')",
    },
    reason: {
      type: 'text',
      check: `reason IN ${REASONS}`,
    },
  });

  // `009` declared the outcome check inline, so it carries Postgres's generated
  // name. Dropped and re-added in this migration's transaction, as `026` does
  // for the item check.
  pgm.dropConstraint('redemptions', 'redemptions_outcome_check', {
    ifExists: true,
  });
  pgm.addConstraint('redemptions', 'redemptions_outcome_check', {
    check: `outcome IN ${OUTCOMES}`,
  });

  pgm.addConstraint('redemptions', 'redemptions_actor_consistency_check', {
    check: `(outcome IN ${CORRECTION_OUTCOMES}) = (actor_type = 'admin')
      AND (reason IS NOT NULL) = (actor_type = 'admin')`,
  });

  pgm.sql(`GRANT INSERT (actor_type, reason) ON redemptions TO ${role}`);

  // Schema-qualified throughout: the pinned `search_path` already rules out
  // shadowing, and the qualification makes that visible in the body itself.
  pgm.sql(`
    CREATE FUNCTION redemption_history(p_event_id text, p_attendee_id uuid)
    RETURNS TABLE (
      item text,
      outcome text,
      actor_type text,
      actor_name text,
      reason text,
      created_at timestamptz
    )
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
      SELECT r.item,
             r.outcome,
             r.actor_type,
             CASE r.actor_type
               WHEN 'admin' THEN a.username
               ELSE v.attendee_name
             END,
             r.reason,
             r.created_at
      FROM public.redemptions r
      LEFT JOIN public.attendees v
        ON r.actor_type = 'volunteer'
       AND v.attendee_id = r.redeemed_by
       AND v.event_id = r.event_id
      LEFT JOIN public.admins a
        ON r.actor_type = 'admin'
       AND a.admin_id = r.redeemed_by
      WHERE r.event_id = p_event_id
        AND r.attendee_id = p_attendee_id
      ORDER BY r.created_at DESC, r.redemption_id
      LIMIT 200
    $$
  `);

  // Functions are executable by PUBLIC on creation. Revoked first, so the only
  // caller is the one granted below.
  pgm.sql('REVOKE ALL ON FUNCTION redemption_history(text, uuid) FROM PUBLIC');
  pgm.sql(
    `GRANT EXECUTE ON FUNCTION redemption_history(text, uuid) TO ${role}`,
  );
};

/**
 * Drops the function, restores the volunteer-only outcome check and drops the
 * two columns.
 *
 * **Fails if any correction has been recorded**, and that is the intended
 * behaviour, as in `026`: `redemptions` is append-only, and the restored check
 * refuses the `marked` and `reverted` rows rather than leaving rows it says
 * cannot exist. Column privileges go with the columns.
 */
export const down = (pgm: MigrationBuilder): void => {
  pgm.sql('DROP FUNCTION redemption_history(text, uuid)');

  pgm.dropConstraint('redemptions', 'redemptions_actor_consistency_check');

  pgm.dropConstraint('redemptions', 'redemptions_outcome_check', {
    ifExists: true,
  });
  pgm.addConstraint('redemptions', 'redemptions_outcome_check', {
    check: `outcome IN ${PREVIOUS_OUTCOMES}`,
  });

  pgm.dropColumn('redemptions', ['actor_type', 'reason']);
};
