import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Adds the flag that decides which volunteers may record a redemption.
 *
 * Read on every request against the staff surface, so that revoking
 * a volunteer mid-event takes effect on their next action.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

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
    can_redeem: { type: 'boolean', notNull: true, default: false },
  });

  pgm.sql(`GRANT SELECT (can_redeem) ON attendees TO ${role}`);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumn('attendees', 'can_redeem');
};
