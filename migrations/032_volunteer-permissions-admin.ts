import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Lets an administrator change a volunteer's permissions, without giving the
 * application role the right to.
 *
 * `008`, `010`, `011`, `022` and `024` each withheld `UPDATE` on their column
 * and said the same thing: the flags are set by the migrator, never through the
 * application, and there is no admin surface for them. This migration changes
 * that policy and keeps the guarantee behind it. What the withholding buys is
 * that a compromised application process cannot promote itself or anyone else,
 * and that still holds:
 *
 * - **Table `UPDATE` stays withheld.** The only write path is
 *   `set_volunteer_permissions`, owned by the migrator and `SECURITY DEFINER`.
 *   It touches the six permission columns and nothing else; `admin_username`
 *   (`031`) is deliberately not settable here.
 * - **The database re-checks the caller.** The function takes the acting
 *   `admin_id` and refuses unless that account is active and holds
 *   `volunteers:write` right now. A compromised process therefore needs a
 *   valid, active administrator id that holds the scope, not just a connection.
 * - **Every change is audited, atomically.** The attendee row is locked, and
 *   the update and its `volunteer_permission_changes` row commit together or
 *   not at all. The application role can read that table and cannot write it.
 *
 * Writes by the migrator, through `scripts/db/set-volunteer-permissions.ts` or
 * `psql`, bypass the function and so leave no audit row.
 *
 * **Why the audit table has no foreign keys.** Administrators are not
 * event-scoped (see `013`) and the roster is purged per event, so a key to
 * either would block a purge or outlive the data it points at. This follows
 * `009`'s `redemptions` and `031`'s `admin_username`. The function checks both
 * ids on the way in, which is the only moment they need to exist.
 *
 * **The table holds personal data** (`attendee_id`, `admin_id`, and team labels
 * in `before` and `after`), so `event_id` is here with no default, for the
 * reason `017` gives: `scripts/db/purge-attendees.sql` has to be able to delete
 * one event's rows. It is inventoried in `docs/security/data-retention.md`.
 *
 * The scope constraint snapshots are hardcoded, for the reason `014` gives.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

/** Every scope the column admits, as of this migration. */
const SCOPES = `ARRAY[
  'attendees:read', 'attendees:write', 'attendees:import', 'checkin:write',
  'redemptions:read', 'redemptions:write', 'raffle:read', 'raffle:write',
  'export:read', 'metrics:read', 'admins:write', 'whatsapp:send',
  'survey:write', 'pass:write', 'volunteers:write'
]::text[]`;

/** The fourteen-scope set this migration replaces, for `down`. */
const PREVIOUS_SCOPES = `ARRAY[
  'attendees:read', 'attendees:write', 'attendees:import', 'checkin:write',
  'redemptions:read', 'redemptions:write', 'raffle:read', 'raffle:write',
  'export:read', 'metrics:read', 'admins:write', 'whatsapp:send',
  'survey:write', 'pass:write'
]::text[]`;

const FUNCTION_SIGNATURE =
  'set_volunteer_permissions(text, uuid, uuid, boolean, text[], boolean, boolean, text, text)';

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

  pgm.dropConstraint('admins', 'admins_scopes_check', { ifExists: true });
  pgm.addConstraint('admins', 'admins_scopes_check', {
    check: `admin_scopes <@ ${SCOPES}`,
  });

  pgm.createTable('volunteer_permission_changes', {
    id: { type: 'bigserial', primaryKey: true },
    event_id: { type: 'text', notNull: true },
    attendee_id: { type: 'uuid', notNull: true },
    admin_id: { type: 'uuid', notNull: true },
    before: { type: 'jsonb', notNull: true },
    after: { type: 'jsonb', notNull: true },
    changed_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('volunteer_permission_changes', [
    'event_id',
    'attendee_id',
    { name: 'changed_at', sort: 'DESC' },
  ]);

  // Read-only for the application: the function, which runs as the owner, is
  // the only writer.
  pgm.sql(`GRANT SELECT ON volunteer_permission_changes TO ${role}`);

  // Schema-qualified throughout: the pinned `search_path` already rules out
  // shadowing, and the qualification makes that visible in the body itself.
  pgm.sql(`
    CREATE FUNCTION set_volunteer_permissions(
      p_event_id text,
      p_attendee_id uuid,
      p_admin_id uuid,
      p_can_redeem boolean,
      p_redeem_scopes text[],
      p_can_draw boolean,
      p_show_admin_link boolean,
      p_team text,
      p_team_role text
    )
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      v_before jsonb;
      v_after jsonb;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM public.admins
        WHERE admin_id = p_admin_id
          AND is_active
          AND 'volunteers:write' = ANY (admin_scopes)
      ) THEN
        RAISE EXCEPTION 'administrator may not change volunteer permissions'
          USING ERRCODE = '42501';
      END IF;

      SELECT jsonb_build_object(
               'can_redeem', can_redeem,
               'redeem_scopes', redeem_scopes,
               'can_draw', can_draw,
               'show_admin_link', show_admin_link,
               'team', team,
               'team_role', team_role
             )
      INTO v_before
      FROM public.attendees
      WHERE attendee_id = p_attendee_id
        AND event_id = p_event_id
        AND attendee_role = 'volunteer'
        AND archived_at IS NULL
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'volunteer not found'
          USING ERRCODE = 'P0002';
      END IF;

      v_after := jsonb_build_object(
        'can_redeem', p_can_redeem,
        'redeem_scopes', p_redeem_scopes,
        'can_draw', p_can_draw,
        'show_admin_link', p_show_admin_link,
        'team', p_team,
        'team_role', p_team_role
      );

      -- redeem_scopes is compared as a set: its stored order varies with how
      -- it was written, and a reordering is not a change.
      IF (v_before -> 'redeem_scopes') @> (v_after -> 'redeem_scopes')
         AND (v_before -> 'redeem_scopes') <@ (v_after -> 'redeem_scopes')
         AND (v_before - 'redeem_scopes') IS NOT DISTINCT FROM
             (v_after - 'redeem_scopes') THEN
        RETURN false;
      END IF;

      UPDATE public.attendees
      SET can_redeem = p_can_redeem,
          redeem_scopes = p_redeem_scopes,
          can_draw = p_can_draw,
          show_admin_link = p_show_admin_link,
          team = p_team,
          team_role = p_team_role
      WHERE attendee_id = p_attendee_id
        AND event_id = p_event_id;

      INSERT INTO public.volunteer_permission_changes
        (event_id, attendee_id, admin_id, before, after)
      VALUES (p_event_id, p_attendee_id, p_admin_id, v_before, v_after);

      RETURN true;
    END
    $$
  `);

  // Functions are executable by PUBLIC on creation. Revoked first, so the only
  // caller is the one granted below.
  pgm.sql(`REVOKE ALL ON FUNCTION ${FUNCTION_SIGNATURE} FROM PUBLIC`);
  pgm.sql(`GRANT EXECUTE ON FUNCTION ${FUNCTION_SIGNATURE} TO ${role}`);
};

/**
 * Drops the function and the audit table, and restores the fourteen-scope
 * constraint.
 *
 * **Fails if any administrator already holds `volunteers:write`**, and that is
 * the intended behaviour: rolling back would otherwise leave rows the
 * constraint says cannot exist. Strip the scope with
 * scripts/admin/set-admin-scopes.ts first, then migrate down. The audit table
 * is dropped with its rows.
 */
export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`DROP FUNCTION ${FUNCTION_SIGNATURE}`);
  pgm.dropTable('volunteer_permission_changes');

  pgm.dropConstraint('admins', 'admins_scopes_check', { ifExists: true });
  pgm.addConstraint('admins', 'admins_scopes_check', {
    check: `admin_scopes <@ ${PREVIOUS_SCOPES}`,
  });
};
