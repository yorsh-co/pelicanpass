import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Adds the opaque token that entry links carry instead of the ticket code.
 *
 * `GET /checkin?t=` used to carry the raw ticket code — the string the attendee
 * types at manual entry — which reaches browser history, in-app browser sync
 * and proxy access logs. Splitting them means a leaked link reveals nothing
 * typable, over a 128-bit space rather than 36^5.
 *
 * The default is evaluated by Postgres because nothing in this repository
 * creates attendee rows: the roster arrives by hand today and by CSV import
 * later, and a column default covers both without either naming the column.
 *
 * 16 random bytes base64-encode to 22 characters plus `==` padding, which
 * `translate` strips while mapping `+/` to the URL-safe `-_`. `gen_random_bytes`
 * is volatile, so ADD COLUMN evaluates the default once per row.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

const DEFAULT_TOKEN_EXPR = `translate(encode(gen_random_bytes(16), 'base64'), '+/=', '-_')`;

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumn('attendees', {
    ticket_link_token: {
      type: 'varchar(22)',
      notNull: true,
      unique: true,
      default: pgm.func(DEFAULT_TOKEN_EXPR),
    },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumn('attendees', 'ticket_link_token');
};
