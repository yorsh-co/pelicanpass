import pg from '../../shared/db/postgres.ts';

import type { AdminScope } from '../../constants/admin-scopes.ts';

/**
 * Reads against the administrator roster.
 *
 * Unlike attendee.repository.ts nothing here is scoped to `env.eventId`:
 * `admins` carries no event, by the reasoning in migration 013. Nothing here
 * writes either, beyond the login timestamp — the application role holds no
 * `INSERT` on this table, so accounts are created only by the CLI running as
 * the migrator.
 */

/** An administrator row, as the columns migration 013 grants `SELECT` on. */
export interface AdminRow {
  admin_id: string;
  username: string;
  password_hash: string;
  admin_scopes: AdminScope[];
  is_active: boolean;
}

/** Columns {@link getAdminByUsername} projects. */
const ADMIN_ROW_COLUMNS = `
  admin_id,
  username,
  password_hash,
  admin_scopes,
  is_active`;

/**
 * Loads an administrator by the name they sign in with.
 *
 * Returns deactivated administrators as well as active ones. The caller checks
 * `is_active` *after* verifying the password, so that a deactivated account and
 * a wrong password are indistinguishable from outside — filtering here would
 * make the response time tell them apart.
 *
 * @param username - Username as typed, already lowercased by the service.
 * @returns The row, or `null` if no administrator has that name.
 */
export const getAdminByUsername = async (
  username: string,
): Promise<AdminRow | null> => {
  const result = await pg.query<AdminRow>(
    `SELECT ${ADMIN_ROW_COLUMNS}
    FROM admins
    WHERE username = $1`,
    [username],
  );

  return result.rows[0] ?? null;
};

/** Columns {@link getAdminPermission} projects. */
export type AdminPermissionRow = Pick<AdminRow, 'admin_scopes' | 'is_active'>;

/**
 * Reads what an administrator may currently do.
 *
 * Read on every gated request rather than carried in the session, so narrowing
 * someone's scopes or deactivating them takes effect on their next action
 * instead of waiting out the session TTL. This is the same trade
 * `getRedeemPermission` makes for volunteers, and for the same reason.
 *
 * @param adminId - Administrator to check.
 * @returns Their scopes and active flag, or `null` if the account is gone.
 */
export const getAdminPermission = async (
  adminId: string,
): Promise<AdminPermissionRow | null> => {
  const result = await pg.query<AdminPermissionRow>(
    `SELECT
      admin_scopes,
      is_active
    FROM admins
    WHERE admin_id = $1`,
    [adminId],
  );

  return result.rows[0] ?? null;
};

/**
 * Records that an administrator signed in.
 *
 * Best-effort at the call site: the session is already minted by the time this
 * runs, so a failure here must not turn a successful login into an error. The
 * column is a convenience for the roster listing, not an audit record.
 *
 * @param adminId - Administrator who signed in.
 */
export const touchAdminLogin = async (adminId: string): Promise<void> => {
  await pg.query(
    `UPDATE admins
      SET last_login_at = now(),
        updated_at = now()
    WHERE admin_id = $1`,
    [adminId],
  );
};
