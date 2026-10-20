import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Adds lunch as a fourth redeemable item, for volunteers only.
 *
 * The same column pair as meal, drink and t-shirt: `lunch_option` is the
 * entitlement, from the approved list, and `lunch_redeemed_at` records
 * collection. The grants mirror theirs exactly — `SELECT` on both as in 005,
 * `UPDATE` on the timestamp as in 009, `INSERT` and `UPDATE` on the option as
 * in 016 — so lunch gains no path the other three do not have.
 *
 * **Participants never have lunch, and the database says so.** The editor and
 * the roster import both refuse it with a readable message, but a hand-written
 * `UPDATE` reaches neither, and the redeem statement's `IS NOT NULL` guard
 * would then hand it out. The check is the backstop they sit in front of.
 *
 * `redemptions.item` and `redeem_scopes` are widened to admit `lunch`.
 * `redeem_scopes` defaults to every item, as 010 set it, so the default gains
 * `lunch` too, and every existing row holding all three items is backfilled:
 * "may record everything" should still mean that after this migration. A
 * volunteer narrowed to a station keeps exactly the station they had.
 *
 * Both constraint snapshots are hardcoded, for the reason 014 gives: a
 * migration that changes meaning when a constant changes is not a snapshot.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/** Every item `redemptions.item` admits, as of this migration. */
const ITEMS = `('meal', 'drink', 'tshirt', 'lunch')`;

/** The three-item set this migration replaces, for `down`. */
const PREVIOUS_ITEMS = `('meal', 'drink', 'tshirt')`;

/** Every scope `redeem_scopes` admits, and the default each new row takes. */
const SCOPES = `ARRAY['tshirt', 'meal', 'drink', 'lunch']::text[]`;

/** The pre-026 scope set, for `down`. */
const PREVIOUS_SCOPES = `ARRAY['tshirt', 'meal', 'drink']::text[]`;

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
    lunch_option: { type: 'text' },
    lunch_redeemed_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('attendees', 'attendees_lunch_volunteer_check', {
    check: "attendee_role = 'volunteer' OR lunch_option IS NULL",
  });

  // Dropped and re-added rather than altered: Postgres has no ALTER for a check
  // expression. Both run in this migration's transaction, so neither column is
  // ever briefly unconstrained. 009 declared the item check inline, so it
  // carries Postgres's generated name.
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
    SET redeem_scopes = redeem_scopes || 'lunch'::text
    WHERE redeem_scopes @> ${PREVIOUS_SCOPES}
      AND NOT 'lunch' = ANY (redeem_scopes)
  `);

  pgm.sql(
    `GRANT SELECT (lunch_option, lunch_redeemed_at) ON attendees TO ${role}`,
  );
  pgm.sql(
    `GRANT UPDATE (lunch_option, lunch_redeemed_at) ON attendees TO ${role}`,
  );
  pgm.sql(`GRANT INSERT (lunch_option) ON attendees TO ${role}`);
};

/**
 * Restores the three-item constraints and drops the lunch columns.
 *
 * **Fails if any `lunch` redemption has been recorded**, and that is the
 * intended behaviour: `redemptions` is append-only, and rolling back would
 * otherwise leave rows the restored constraint says cannot exist.
 *
 * `lunch` is stripped from every `redeem_scopes` before the narrower check goes
 * back on. Column privileges and the volunteer check are dropped with the
 * columns, so there is nothing to revoke first.
 */
export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('redemptions', 'redemptions_item_check', {
    ifExists: true,
  });
  pgm.addConstraint('redemptions', 'redemptions_item_check', {
    check: `item IN ${PREVIOUS_ITEMS}`,
  });

  pgm.sql(
    `UPDATE attendees SET redeem_scopes = array_remove(redeem_scopes, 'lunch')`,
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

  pgm.dropColumn('attendees', ['lunch_option', 'lunch_redeemed_at']);
};
