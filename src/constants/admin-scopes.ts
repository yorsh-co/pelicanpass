/**
 * Single source of truth for what an administrator may be permitted to do.
 *
 * Read by three things that must not drift apart: the `CHECK` constraint in
 * migration 013, `requireAdminScope` in permission.middleware.ts, and the
 * provisioning scripts under scripts/admin. A scope that exists in only two of
 * the three is either unenforceable or ungrantable.
 *
 * Scopes are `resource:action` rather than roles. A role is a name for a set of
 * permissions, and the set is what the gates actually check — naming it as well
 * would put the same decision in two places and let them disagree.
 */

/**
 * Every scope an administrator may hold, as the array the migration's `CHECK`
 * and the CLI validate against. What each permits on screen is
 * `admin-shell.scope.*`.
 */
export const ADMIN_SCOPE_VALUES = [
  'attendees:read',
  'attendees:write',
  'attendees:import',
  'checkin:write',
  'redemptions:read',
  'redemptions:write',
  'raffle:read',
  'raffle:write',
  'export:read',
  'metrics:read',
  'admins:write',
  'whatsapp:send',
  'survey:write',
  'pass:write',
  'volunteers:write',
  'tshirt:redeem',
  'attendees:limit',
] as const;

/** One thing an administrator may be permitted to do. */
export type AdminScope = (typeof ADMIN_SCOPE_VALUES)[number];

/** Narrows an unchecked string to an admin scope. */
export const isAdminScope = (value: string): value is AdminScope =>
  (ADMIN_SCOPE_VALUES as readonly string[]).includes(value);
