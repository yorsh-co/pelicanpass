import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Adds the team a volunteer works on and their role in it, shown on the pass in
 * place of the welcome line.
 *
 * **A label, not a permission.** It tells the volunteer — and whoever looks at
 * their phone — where they are posted. Nothing in the request path reads these
 * columns except the pass render, and neither widens what the volunteer may do;
 * access stays with the flags from 008, 010 and 011.
 *
 * Free text rather than a fixed list: teams and roles change from one event to
 * the next, and the coordinators who assign them should not need a deploy to
 * add one. The length check keeps a value on one line of a phone screen.
 *
 * Nullable, with `NULL` meaning "not assigned": the pass falls back to the
 * welcome. `SELECT` without `UPDATE`, like the flags in 008, 010, 011 and 022:
 * they are set as the migrator role by `scripts/db/set-volunteer-permissions.ts`
 * or in `psql`, never through the application.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

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
    team: {
      type: 'text',
      check: 'char_length(team) BETWEEN 1 AND 40',
    },
    team_role: {
      type: 'text',
      check: 'char_length(team_role) BETWEEN 1 AND 40',
    },
  });

  pgm.sql(`GRANT SELECT (team, team_role) ON attendees TO ${role}`);
};

export const down = (pgm: MigrationBuilder): void => {
  // Column privileges and checks are dropped with the columns, so there is
  // nothing to revoke first.
  pgm.dropColumn('attendees', ['team', 'team_role']);
};
