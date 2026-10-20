import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Narrows a redeemer to the station they are actually working.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/** Every value the column admits, and the default every row starts with. */
const SCOPES = `ARRAY['tshirt', 'meal', 'drink']::text[]`;

/**
 * Reads the application role name from the environment.
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
    redeem_scopes: {
      type: 'text[]',
      notNull: true,
      default: pgm.func(SCOPES),
    },
  });

  pgm.addConstraint('attendees', 'attendees_redeem_scopes_check', {
    check: `redeem_scopes <@ ${SCOPES}`,
  });

  pgm.sql(`GRANT SELECT (redeem_scopes) ON attendees TO ${role}`);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('attendees', 'attendees_redeem_scopes_check');
  pgm.dropColumn('attendees', 'redeem_scopes');
};
