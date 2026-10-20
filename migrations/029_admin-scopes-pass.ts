import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Widens the administrator scope constraint from thirteen values to fourteen,
 * adding `pass:write`.
 *
 * A separate scope because rescheduling the welcome line changes what every
 * attendee's pass says, and nothing else an administrator holds implies that:
 * `survey:write` opens a form, it does not word the pass.
 *
 * Follows `014`, `019` and `021`, and for the same reason hardcodes both
 * literals rather than importing `ADMIN_SCOPE_VALUES`: 013 builds its `CHECK`
 * from that constant, so a fresh database and an existing one start from
 * different sets, and only a snapshot here makes them end at the same
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
  'survey:write', 'pass:write'
]::text[]`;

/** The thirteen-scope set this migration replaces, for `down`. */
const PREVIOUS_SCOPES = `ARRAY[
  'attendees:read', 'attendees:write', 'attendees:import', 'checkin:write',
  'redemptions:read', 'redemptions:write', 'raffle:read', 'raffle:write',
  'export:read', 'metrics:read', 'admins:write', 'whatsapp:send',
  'survey:write'
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
 * Restores the thirteen-scope constraint.
 *
 * **Fails if any administrator already holds `pass:write`**, and that is the
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
