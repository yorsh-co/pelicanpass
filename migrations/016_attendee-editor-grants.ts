import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Grants the writes the administrator's attendees editor makes.
 *
 * **This is the first `INSERT` the application role has ever held on
 * `attendees`.** Migration 004's JSDoc records why there was none: "nothing in
 * this repository creates attendee rows — the roster arrives by hand today and
 * by CSV import later". A walk-in at the door was a `psql` session until now.
 *
 * It also widens `UPDATE` from the four check-in columns of `005` plus `007`'s
 * nickname to the whole registration record. Grants are role-wide rather than
 * route-wide, so the role that serves public `/checkin` carries every privilege
 * below. What bounds it is that the only statements using them live in
 * `admin.attendees.repository.ts`, behind `requireAdminScope('attendees:write')`
 * on a listener that answers only on the tailnet.
 *
 * Two of the six updatable columns are worth naming rather than hiding inside
 * "the registration record", because they are not like the other four:
 *
 * - **`attendee_phone` is a credential column.** Its last four digits are the
 *   verification code — `verifyAttendee` compares `attendee_phone.slice(-4)`,
 *   and docs/security/data-retention.md calls it "the only thing standing between a
 *   guessed five-character ticket code and someone else's check-in". `UPDATE`
 *   on it means a flaw anywhere in the application could rewrite an attendee's
 *   code and then check in as them. That is inherent to the feature: an editor
 *   that cannot fix a mistyped number is not an editor, and no narrower grant
 *   allows it.
 * - **`attendee_role` is a decision input twice over.** `checkin.window.ts`
 *   opens the volunteer window before the participant one, and
 *   `completeCheckin` assigns a `checkin_number` only to participants. So
 *   participant → volunteer buys an earlier door, and volunteer → participant
 *   buys a place in a raffle built to exclude volunteers.
 *
 * The service refuses both in the cases that matter — a role cannot change once
 * an attendee has checked in — but a service rule is not a privilege, and the
 * grant is what a flaw inherits.
 *
 * **`ticket_code` gets `INSERT` and deliberately not `UPDATE`.** That is what
 * makes "a ticket code is immutable once issued" a property of the database
 * rather than a convention in the service: the code is printed on a QR and
 * typed at a door, and `ticket_link_token` is a second credential that would
 * have to be rotated with it. Re-issuing means archiving the row and creating a
 * new one.
 *
 * Absent for their own reasons, none of them oversights:
 *
 * - `attendee_id`, `ticket_link_token` and `created_at` carry defaults and are
 *   never named by the editor's statements. Column privileges apply only to
 *   columns a statement names, so all three are written by Postgres and stay
 *   outside the application's reach — which is precisely what should be true of
 *   the entry-link credential.
 * - `attendee_nickname` already has `UPDATE` from `007`. The editor only ever
 *   clears one; setting a nickname is the attendee's own act.
 * - `archived_at` came from `015`.
 * - `checkin_complete`, `checkin_at`, `checkin_number` and `updated_at` already
 *   have theirs from `005`, and `*_redeemed_at` from `009`. The editor touches
 *   none of them.
 * - `can_redeem`, `redeem_scopes` and `can_draw` stay `SELECT`-only, exactly as
 *   `008`, `010` and `011` left them, "so a compromised session cannot promote
 *   itself". The editor displays them and cannot change them; appointing a
 *   volunteer remains a migrator-role statement.
 *
 * Grants are additive, so this extends `005`'s lists rather than replacing
 * them. `\\dp attendees` is the authority if the two ever read as
 * contradictory — the note `007` carries, for the same reason.
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

/**
 * Columns the editor names when it creates an attendee.
 *
 * `event_id` is here because `006` gave the column no default: every insert has
 * to name the event it belongs to, and a not-null violation is the loud failure
 * that choice exists to produce.
 */
const INSERTABLE_COLUMNS = [
  'event_id',
  'ticket_code',
  'attendee_name',
  'attendee_phone',
  'attendee_role',
  'meal_option',
  'drink_option',
  'tshirt_size',
].join(', ');

/** Columns the editor names when it edits one. */
const UPDATABLE_COLUMNS = [
  'attendee_name',
  'attendee_phone',
  'attendee_role',
  'meal_option',
  'drink_option',
  'tshirt_size',
].join(', ');

export const up = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.sql(`GRANT INSERT (${INSERTABLE_COLUMNS}) ON attendees TO ${role}`);
  pgm.sql(`GRANT UPDATE (${UPDATABLE_COLUMNS}) ON attendees TO ${role}`);
};

/**
 * Revokes exactly what `up` granted, column by column.
 *
 * Never `REVOKE ALL`: `005`, `007`, `009` and `015` all granted on this table
 * and this migration owns none of theirs. Revoking broadly would leave the
 * application unable to complete a check-in or record a redemption — a far
 * larger outage than rolling back an editor.
 */
export const down = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.sql(`REVOKE INSERT (${INSERTABLE_COLUMNS}) ON attendees FROM ${role}`);
  pgm.sql(`REVOKE UPDATE (${UPDATABLE_COLUMNS}) ON attendees FROM ${role}`);
};
