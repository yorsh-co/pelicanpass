import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

/**
 * Adds the time of day a volunteer is expected to arrive, and lets an
 * administrator set it.
 *
 * `checkin_time` is a plain `time`: the event is a single day, so the date is
 * implied and a time zone would only invite a wrong one. It is **not shown on
 * the pass**; it exists to be sent to the volunteer in a message.
 *
 * **Volunteers only, and the database says so**, as `026` does for
 * `lunch_option`. The editor and the CSV import both refuse a time for a
 * participant, but a hand-written `UPDATE` reaches neither. **Whole minutes
 * only**, because every writer takes `HH:MM` and a stored `08:30:15` could
 * never be shown or re-entered as typed.
 *
 * **Grants follow `024` and `032`.** `SELECT` on the column and no `UPDATE`:
 * the only write path for the application is `set_volunteer_permissions`,
 * which takes the new value as `p_checkin_time` and snapshots it in the audit
 * row beside `team` and `team_role`. The function keeps everything `032`
 * explains: it is `SECURITY DEFINER`, re-checks the acting administrator and
 * writes the change and its audit row atomically.
 *
 * **The signature changes, so the old function is dropped, not replaced.**
 * `CREATE OR REPLACE` with a new parameter list would leave both overloads
 * callable, and the old one would write everything but the time. Grants are
 * reset as `032` does, since a new function is executable by `PUBLIC`. Audit
 * rows written before this migration carry no `checkin_time` key; readers
 * treat that as unset.
 *
 * The audit table holds the time in `before` and `after`, so it stays
 * inventoried in `docs/security/data-retention.md` with the rest of the roster.
 */

export const shorthands: ColumnDefinitions | undefined = undefined;

const FUNCTION_SIGNATURE =
  'set_volunteer_permissions(text, uuid, uuid, boolean, text[], boolean, boolean, text, text, time)';

/** The signature `032` created, for `down` and to drop on `up`. */
const PREVIOUS_FUNCTION_SIGNATURE =
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

  pgm.addColumn('attendees', { checkin_time: { type: 'time' } });

  pgm.addConstraint('attendees', 'attendees_checkin_time_volunteer_check', {
    check: "attendee_role = 'volunteer' OR checkin_time IS NULL",
  });

  pgm.addConstraint('attendees', 'attendees_checkin_time_minute_check', {
    check: 'extract(second from checkin_time) = 0',
  });

  pgm.sql(`GRANT SELECT (checkin_time) ON attendees TO ${role}`);

  pgm.sql(`DROP FUNCTION ${PREVIOUS_FUNCTION_SIGNATURE}`);

  // Schema-qualified throughout, as in `032`.
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
      p_team_role text,
      p_checkin_time time
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
               'team_role', team_role,
               'checkin_time', checkin_time
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
        'team_role', p_team_role,
        'checkin_time', p_checkin_time
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
          team_role = p_team_role,
          checkin_time = p_checkin_time
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
 * Restores `032`'s function and grants, then drops the column.
 *
 * Any `checkin_time` already set is lost with the column; audit rows keep the
 * key in their snapshots, which nothing reads once the function is back.
 * Column privileges and both checks are dropped with the column.
 */
export const down = (pgm: MigrationBuilder): void => {
  const role = appRole();

  pgm.sql(`DROP FUNCTION ${FUNCTION_SIGNATURE}`);

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

  pgm.sql(`REVOKE ALL ON FUNCTION ${PREVIOUS_FUNCTION_SIGNATURE} FROM PUBLIC`);
  pgm.sql(
    `GRANT EXECUTE ON FUNCTION ${PREVIOUS_FUNCTION_SIGNATURE} TO ${role}`,
  );

  pgm.dropColumn('attendees', 'checkin_time');
};
