import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Adds the volunteer t-shirt as a fifth redeemable item, for volunteers only.
 *
 * Distinct from `tshirt`, which stays the participant-facing one: a volunteer
 * may hold both. The same column pair as the others: `tshirt_volunteer_size` is
 * the entitlement, from the approved list, and `tshirt_volunteer_redeemed_at`
 * records collection. The grants mirror 026's exactly, so the item gains no
 * path the other four do not have.
 *
 * **Participants never have it, and the database says so**, for the reason 026
 * gives for lunch: the editor and the roster import refuse it with a readable
 * message, and the check is the backstop behind a hand-written `UPDATE`.
 *
 * `redemptions.item` and `redeem_scopes` are widened to admit
 * `tshirt_volunteer`. The `redeem_scopes` default gains it, and every row
 * holding all four items is backfilled, so "may record everything" still means
 * that. A volunteer narrowed to a station keeps exactly the station they had.
 *
 * Both constraint snapshots are hardcoded, for the reason 014 gives.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/** Every item `redemptions.item` admits, as of this migration. */
const ITEMS = `('meal', 'drink', 'tshirt', 'lunch', 'tshirt_volunteer')`;

/** The four-item set this migration replaces, for `down`. */
const PREVIOUS_ITEMS = `('meal', 'drink', 'tshirt', 'lunch')`;

/** Every scope `redeem_scopes` admits, and the default each new row takes. */
const SCOPES = `ARRAY['tshirt', 'meal', 'drink', 'lunch', 'tshirt_volunteer']::text[]`;

/** The pre-028 scope set, for `down`. */
const PREVIOUS_SCOPES = `ARRAY['tshirt', 'meal', 'drink', 'lunch']::text[]`;

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

  pgm.addColumn('attendees', {
    tshirt_volunteer_size: { type: 'text' },
    tshirt_volunteer_redeemed_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('attendees', 'attendees_tshirt_volunteer_volunteer_check', {
    check: "attendee_role = 'volunteer' OR tshirt_volunteer_size IS NULL",
  });

  // Dropped and re-added in this migration's transaction, as 026 does.
  pgm.dropConstraint('redemptions', 'redemptions_item_check', {
    ifExists: true,
  });
  pgm.addConstraint('redemptions', 'redemptions_item_check', {
    check: `item IN ${ITEMS}`,
  });

  pgm.dropConstraint('attendees', 'attendees_redeem_scopes_check', {
    ifExists: true,
  });
  pgm.addConstraint('attendees', 'attendees_redeem_scopes_check', {
    check: `redeem_scopes <@ ${SCOPES}`,
  });
  pgm.alterColumn('attendees', 'redeem_scopes', {
    default: pgm.func(SCOPES),
  });
  pgm.sql(`
    UPDATE attendees
    SET redeem_scopes = redeem_scopes || 'tshirt_volunteer'::text
    WHERE redeem_scopes @> ${PREVIOUS_SCOPES}
      AND NOT 'tshirt_volunteer' = ANY (redeem_scopes)
  `);

  pgm.sql(
    `GRANT SELECT (tshirt_volunteer_size, tshirt_volunteer_redeemed_at) ON attendees TO ${role}`,
  );
  pgm.sql(
    `GRANT UPDATE (tshirt_volunteer_size, tshirt_volunteer_redeemed_at) ON attendees TO ${role}`,
  );
  pgm.sql(`GRANT INSERT (tshirt_volunteer_size) ON attendees TO ${role}`);
};

/**
 * Restores the four-item constraints and drops the volunteer t-shirt columns.
 *
 * **Fails if any `tshirt_volunteer` redemption has been recorded**, and that is
 * the intended behaviour, as in 026: `redemptions` is append-only.
 *
 * `tshirt_volunteer` is stripped from every `redeem_scopes` before the narrower
 * check goes back on. Column privileges and the volunteer check are dropped
 * with the columns.
 */
export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('redemptions', 'redemptions_item_check', {
    ifExists: true,
  });
  pgm.addConstraint('redemptions', 'redemptions_item_check', {
    check: `item IN ${PREVIOUS_ITEMS}`,
  });

  pgm.sql(
    `UPDATE attendees SET redeem_scopes = array_remove(redeem_scopes, 'tshirt_volunteer')`,
  );
  pgm.dropConstraint('attendees', 'attendees_redeem_scopes_check', {
    ifExists: true,
  });
  pgm.addConstraint('attendees', 'attendees_redeem_scopes_check', {
    check: `redeem_scopes <@ ${PREVIOUS_SCOPES}`,
  });
  pgm.alterColumn('attendees', 'redeem_scopes', {
    default: pgm.func(PREVIOUS_SCOPES),
  });

  pgm.dropColumn('attendees', [
    'tshirt_volunteer_size',
    'tshirt_volunteer_redeemed_at',
  ]);
};
