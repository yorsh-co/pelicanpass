import { env } from '../../config/env.ts';
import pg from '../../shared/db/postgres.ts';

import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error.ts';

import type { RedemptionItem } from '../../constants/pass.ts';
import type { VolunteerPermissions } from './admin.volunteers.rules.ts';

/**
 * The administrator's view of volunteers and their permissions.
 *
 * Reads are plain `SELECT`s. The write goes through
 * `set_volunteer_permissions`, the only write path `032` leaves the
 * application, which re-checks the acting administrator and writes the audit
 * row. Every statement is scoped to `env.eventId`, for the reason
 * `admin.attendees.repository.ts` gives.
 */

/** One volunteer, as the permissions screen lists them. */
export interface VolunteerRow {
  attendee_id: string;
  attendee_name: string;
  attendee_nickname: string | null;
  ticket_code: string;
  can_redeem: boolean;
  redeem_scopes: string[];
  can_draw: boolean;
  show_admin_link: boolean;
  team: string | null;
  team_role: string | null;

  /** `HH:MM`, as the screen and the API carry it. */
  checkin_time: string | null;
  admin_username: string | null;

  /** Scopes of the linked account while it is active; `null` otherwise. */
  admin_scopes: string[] | null;
}

/** A volunteer, and whether the account they are linked to is switched off. */
export interface VolunteerDetailRow extends VolunteerRow {
  /** The linked account exists and is inactive. */
  admin_disabled: boolean;
}

/** The permission columns as the audit table snapshots them. */
export interface PermissionSnapshot {
  can_redeem: boolean;
  redeem_scopes: RedemptionItem[];
  can_draw: boolean;
  show_admin_link: boolean;
  team: string | null;
  team_role: string | null;

  /** `HH:MM`. Absent from entries written before migration 035. */
  checkin_time: string | null;
}

/** One entry of a volunteer's change history. */
export interface VolunteerChangeRow {
  before: PermissionSnapshot;
  after: PermissionSnapshot;
  changed_at: Date;

  /** `null` when the administrator's account has since been deleted. */
  username: string | null;
}

const VOLUNTEER_COLUMNS = `a.attendee_id,
            a.attendee_name,
            a.attendee_nickname,
            a.ticket_code,
            a.can_redeem,
            a.redeem_scopes,
            a.can_draw,
            a.show_admin_link,
            a.team,
            a.team_role,
            to_char(a.checkin_time, 'HH24:MI') AS checkin_time,
            a.admin_username,
            ad.admin_scopes`;

/**
 * Reads a snapshot's `checkin_time` as `HH:MM`. The audit table stores
 * Postgres's own `HH:MM:SS`, and entries older than migration 035 have none.
 *
 * @param snapshot - A `before` or `after` as stored.
 */
const withClock = (snapshot: PermissionSnapshot): PermissionSnapshot => ({
  ...snapshot,
  checkin_time: snapshot.checkin_time?.slice(0, 5) ?? null,
});

/**
 * Every volunteer of the event who is not archived.
 *
 * The join takes the linked account only while it is active, as
 * `getAttendeeProfile` does, so `admin_scopes` is what the pass's tier is
 * derived from.
 *
 * @returns Volunteers ordered as the roster is.
 */
export const listVolunteers = async (): Promise<VolunteerRow[]> => {
  const result = await pg.query<VolunteerRow>(
    `SELECT ${VOLUNTEER_COLUMNS}
     FROM attendees a
     LEFT JOIN admins ad
       ON ad.username = a.admin_username
       AND ad.is_active
     WHERE a.event_id = $1
       AND a.attendee_role = 'volunteer'
       AND a.archived_at IS NULL
     ORDER BY a.attendee_name, a.ticket_code`,
    [env.eventId],
  );

  return result.rows;
};

/**
 * One volunteer.
 *
 * @param attendeeId - Attendee to read.
 * @returns The volunteer, or `null` if the ID is not a non-archived volunteer
 *   of this event.
 */
export const getVolunteer = async (
  attendeeId: string,
): Promise<VolunteerDetailRow | null> => {
  const result = await pg.query<VolunteerDetailRow>(
    `SELECT ${VOLUNTEER_COLUMNS},
            coalesce(linked.is_active = false, false) AS admin_disabled
     FROM attendees a
     LEFT JOIN admins linked
       ON linked.username = a.admin_username
     LEFT JOIN admins ad
       ON ad.admin_id = linked.admin_id
       AND ad.is_active
     WHERE a.attendee_id = $1
       AND a.event_id = $2
       AND a.attendee_role = 'volunteer'
       AND a.archived_at IS NULL`,
    [attendeeId, env.eventId],
  );

  return result.rows[0] ?? null;
};

/**
 * A volunteer's permission changes, newest first.
 *
 * @param attendeeId - Attendee whose history is read.
 * @param limit - Most entries to return.
 */
export const volunteerChanges = async (
  attendeeId: string,
  limit = 20,
): Promise<VolunteerChangeRow[]> => {
  const result = await pg.query<VolunteerChangeRow>(
    `SELECT c.before,
            c.after,
            c.changed_at,
            ad.username
     FROM volunteer_permission_changes c
     LEFT JOIN admins ad ON ad.admin_id = c.admin_id
     WHERE c.event_id = $1
       AND c.attendee_id = $2
     ORDER BY c.changed_at DESC, c.id DESC
     LIMIT $3`,
    [env.eventId, attendeeId, limit],
  );

  return result.rows.map(({ before, after, ...row }) => ({
    ...row,
    before: withClock(before),
    after: withClock(after),
  }));
};

/** Everything {@link setVolunteerPermissions} needs to act and to audit. */
export interface SetPermissionsInput {
  attendeeId: string;
  adminId: string;
  values: VolunteerPermissions;
}

/**
 * Saves a volunteer's permissions through `set_volunteer_permissions`.
 *
 * **Errors are mapped by SQLSTATE alone, and the driver's error is dropped.**
 * A check or not-null violation carries the whole `attendees` row in `detail`,
 * name and phone included; none of it is wrapped, logged or returned. The
 * logger redacts `err.detail` as well (`redact-paths.ts`), but the error that
 * never leaves this function cannot reach it.
 *
 * @param input - The acting administrator and the validated values.
 * @returns Whether anything changed; a save identical to the stored state
 *   writes no audit row.
 * @throws {ForbiddenError} If the administrator is not active and scoped.
 * @throws {NotFoundError} If the attendee is not a non-archived volunteer.
 * @throws {ValidationError} If a column check refused a value.
 */
export const setVolunteerPermissions = async (
  input: SetPermissionsInput,
): Promise<{ changed: boolean }> => {
  const { attendeeId, adminId, values } = input;

  try {
    const result = await pg.query<{ changed: boolean }>(
      `SELECT set_volunteer_permissions(
         $1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10::time
       ) AS changed`,
      [
        env.eventId,
        attendeeId,
        adminId,
        values.canRedeem,
        values.redeemScopes,
        values.canDraw,
        values.showAdminLink,
        values.team,
        values.teamRole,
        values.checkinTime,
      ],
    );

    return { changed: result.rows[0]?.changed === true };
  } catch (err) {
    switch ((err as { code?: unknown }).code) {
      case '42501':
        throw new ForbiddenError();
      case 'P0002':
        throw new NotFoundError('Volunteer not found');
      case '23514':
      case '23502':
        throw new ValidationError('Invalid volunteer permissions');
      default:
        throw err;
    }
  }
};
