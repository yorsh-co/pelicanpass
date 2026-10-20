import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Widens the administrator scope constraint from eight values to eleven.
 *
 * The three additions are separations rather than new powers:
 * `metrics:read` because watching live check-in statistics is not the same
 * trust as exporting the roster, `attendees:import` because a CSV load creating
 * hundreds of rows is a different blast radius from editing one attendee, and
 * `checkin:write` because marking someone present by hand bypasses the QR
 * verification step the rest of the system is built on.
 *
 * Migration 013 builds its `CHECK` by importing `ADMIN_SCOPE_VALUES`, so a
 * fresh database gets whatever that constant holds at the moment it runs while
 * an existing one holds whatever it held when 013 ran. This migration
 * hardcodes both literals, which is what makes the two agree: the snapshot
 * below overwrites either starting point. That also makes it a re-assertion on
 * a fresh database rather than a change, which is correct — the two paths must
 * end at the same constraint.
 *
 * No grant changes. 013 already granted `SELECT (admin_scopes)`, and a `CHECK`
 * touches no privileges.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Every scope the column admits, as of this migration.
 *
 * Hardcoded rather than imported from `src/constants/admin-scopes.ts`,
 * following the discipline 007 and 009 apply to the role name: a migration
 * that changes meaning when a constant changes is not a snapshot, and two
 * databases migrated a month apart would disagree about what they enforce.
 */
const SCOPES = `ARRAY[
  'attendees:read', 'attendees:write', 'attendees:import', 'checkin:write',
  'redemptions:read', 'redemptions:write', 'raffle:read', 'raffle:write',
  'export:read', 'metrics:read', 'admins:write'
]::text[]`;

/** The eight-scope set this migration replaces, for `down`. */
const PREVIOUS_SCOPES = `ARRAY[
  'attendees:read', 'attendees:write', 'redemptions:read', 'redemptions:write',
  'raffle:read', 'raffle:write', 'export:read', 'admins:write'
]::text[]`;

export const up = (pgm: MigrationBuilder): void => {
  // Dropped and re-added rather than altered: Postgres has no ALTER for a check
  // expression. Both statements run in this migration's transaction, so the
  // column is never briefly unconstrained. `ifExists` covers a database where
  // the constraint was dropped by hand; after 013 it is always present.
  pgm.dropConstraint('admins', 'admins_scopes_check', { ifExists: true });

  pgm.addConstraint('admins', 'admins_scopes_check', {
    check: `admin_scopes <@ ${SCOPES}`,
  });
};

/**
 * Restores the eight-scope constraint.
 *
 * **Fails if any administrator already holds one of the three new scopes**, and
 * that is the intended behaviour: rolling back would otherwise leave rows the
 * constraint says cannot exist. Strip the scopes with
 * scripts/admin/set-admin-scopes.ts first, then migrate down.
 *
 * Restores the pre-014 snapshot, not "whatever 013 would build today" — see the
 * note above on why 013 is not a fixed point.
 */
export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('admins', 'admins_scopes_check', { ifExists: true });

  pgm.addConstraint('admins', 'admins_scopes_check', {
    check: `admin_scopes <@ ${PREVIOUS_SCOPES}`,
  });
};
