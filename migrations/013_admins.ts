import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

import { ADMIN_SCOPE_VALUES } from '../src/constants/admin-scopes.ts';

/**
 * The administrator roster behind `/admin`.
 *
 * Deliberately **not** `event_id`-scoped, unlike `attendees`. An administrator
 * operates the deployment rather than attending an event, and the same people
 * run consecutive events from this stack — scoping them would mean re-creating
 * the roster every time the attendee table is purged. Attendee data an
 * administrator goes on to read is still event-scoped by the repository, which
 * is where that filter belongs.
 *
 * The application role gets **no `INSERT` and no `DELETE`** here. Accounts are
 * created by scripts/admin/create-admin.ts running as the migrator role, so a
 * flaw reachable from a request cannot mint an administrator. That is also what
 * makes the `admins:write` scope inert for now: it is reserved in the check
 * constraint below, but nothing can act on it until a later migration grants
 * the privilege.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Reads the application role name from the environment.
 *
 * `POSTGRES_USER` is what the application connects as, so taking the name from
 * there keeps one source of truth with `01-roles.sh` and the running container.
 * The value is interpolated into SQL as an identifier, so it is constrained to
 * an unquoted-identifier shape rather than trusted.
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

/**
 * Every scope the column admits, as a SQL array literal.
 *
 * Built from the same constant the middleware and the CLI read, so a scope
 * added in one place cannot be silently unenforceable in another. The values
 * are `[a-z:]` by construction, which is what makes interpolating them safe.
 */
const SCOPES = `ARRAY[${ADMIN_SCOPE_VALUES.map((scope) => `'${scope}'`).join(
  ', ',
)}]::text[]`;

/** Columns the application reads, whether projected or only filtered on. */
const READABLE_COLUMNS = [
  'admin_id',
  'username',
  'password_hash',
  'admin_scopes',
  'is_active',
].join(', ');

/** Columns the login path writes. */
const WRITABLE_COLUMNS = ['last_login_at', 'updated_at'].join(', ');

export const up = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.createTable('admins', {
    admin_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    username: { type: 'text', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    admin_scopes: {
      type: 'text[]',
      notNull: true,
      default: pgm.func(`ARRAY[]::text[]`),
    },
    is_active: { type: 'boolean', notNull: true, default: true },
    last_login_at: { type: 'timestamptz' },
    password_changed_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Case is not identity. Without this, `Joshua` and `joshua` are two accounts
  // that look like one in every listing, and the login lookup would resolve
  // whichever was typed. Normalising on the way in is not enough on its own —
  // the constraint is what stops a hand-written INSERT from sidestepping it.
  pgm.addConstraint('admins', 'admins_username_lowercase_check', {
    check: `username = lower(username)`,
  });

  pgm.addConstraint('admins', 'admins_username_length_check', {
    check: `char_length(username) BETWEEN 3 AND 64`,
  });

  pgm.addConstraint('admins', 'admins_scopes_check', {
    check: `admin_scopes <@ ${SCOPES}`,
  });

  // Revoke first so the resulting privileges are exactly what is listed here,
  // regardless of anything granted by hand beforehand.
  pgm.sql(`REVOKE ALL ON admins FROM ${role}`);

  pgm.sql(`GRANT SELECT (${READABLE_COLUMNS}) ON admins TO ${role}`);
  pgm.sql(`GRANT UPDATE (${WRITABLE_COLUMNS}) ON admins TO ${role}`);
};

export const down = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.sql(`REVOKE ALL ON admins FROM ${role}`);
  pgm.dropTable('admins');
};
