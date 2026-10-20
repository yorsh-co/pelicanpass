import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Widens the administrator scope constraint from fifteen values to sixteen,
 * adding `tshirt:redeem`.
 *
 * A separate scope because the T-shirt desk is staffed by people who hand over
 * shirts and nothing else. `redemptions:write` is a correction tool and needs
 * `redemptions:read` beside it, and `attendees:read` opens the whole roster;
 * granting either to the desk would give it far more than the job needs.
 * `tshirt:redeem` both opens the screen and permits the one write behind it.
 *
 * Follows `014`, `019`, `021`, `029` and `032`, and for the same reason
 * hardcodes both literals rather than importing `ADMIN_SCOPE_VALUES`: 013 builds
 * its `CHECK` from that constant, so a fresh database and an existing one start
 * from different sets, and only a snapshot here makes them end at the same
 * constraint.
 *
 * No grant changes. 013 already granted `SELECT (admin_scopes)`, and a `CHECK`
 * touches no privileges.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/** Every scope the column admits, as of this migration. */
const SCOPES = `ARRAY[
  'attendees:read', 'attendees:write', 'attendees:import', 'checkin:write',
  'redemptions:read', 'redemptions:write', 'raffle:read', 'raffle:write',
  'export:read', 'metrics:read', 'admins:write', 'whatsapp:send',
  'survey:write', 'pass:write', 'volunteers:write', 'tshirt:redeem'
]::text[]`;

/** The fifteen-scope set this migration replaces, for `down`. */
const PREVIOUS_SCOPES = `ARRAY[
  'attendees:read', 'attendees:write', 'attendees:import', 'checkin:write',
  'redemptions:read', 'redemptions:write', 'raffle:read', 'raffle:write',
  'export:read', 'metrics:read', 'admins:write', 'whatsapp:send',
  'survey:write', 'pass:write', 'volunteers:write'
]::text[]`;

export const up = (pgm: MigrationBuilder): void => {
  // Dropped and re-added rather than altered: Postgres has no ALTER for a check
  // expression. Both statements run in this migration's transaction, so the
  // column is never briefly unconstrained.
  pgm.dropConstraint('admins', 'admins_scopes_check', { ifExists: true });

  pgm.addConstraint('admins', 'admins_scopes_check', {
    check: `admin_scopes <@ ${SCOPES}`,
  });
};

/**
 * Restores the fifteen-scope constraint.
 *
 * **Fails if any administrator already holds `tshirt:redeem`**, and that is the
 * intended behaviour: rolling back would otherwise leave rows the constraint
 * says cannot exist. Strip the scope with scripts/admin/set-admin-scopes.ts
 * first, then migrate down.
 */
export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('admins', 'admins_scopes_check', { ifExists: true });

  pgm.addConstraint('admins', 'admins_scopes_check', {
    check: `admin_scopes <@ ${PREVIOUS_SCOPES}`,
  });
};
