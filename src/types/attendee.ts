import type { AccessTier } from '../constants/access-tier.ts';

/** Role assigned to an attendee, mirroring the `attendee_role` check constraint. */
export type AttendeeRole = 'participant' | 'volunteer';

/**
 * A full row of the `attendees` table, in database column casing.
 *
 * Nullability mirrors migrations/002_attendees-table.js: only the primary key,
 * ticket_code, attendee_name, attendee_phone, attendee_role, checkin_complete
 * and created_at are NOT NULL. The `*_redeemed_at` columns are timestamptz, so
 * they carry a redemption time rather than a boolean flag.
 *
 * Queries that project a subset of columns should narrow this with `Pick`
 * rather than annotating a partial row as the whole entry.
 */
export interface AttendeeEntry {
  attendee_id: string;
  event_id: string | null;

  ticket_code: string;
  attendee_name: string;
  attendee_phone: string;

  /** Chosen by the attendee; null until they set one, and again if they clear it. */
  attendee_nickname: string | null;

  attendee_role: AttendeeRole;

  /**
   * Whether this volunteer may record a redemption. Added by migration 008,
   * granted `SELECT` and deliberately not `UPDATE` — nothing in the application
   * ever sets it, so a compromised session cannot promote itself.
   */
  can_redeem: boolean;

  /**
   * Which items this volunteer may record, narrowing {@link can_redeem} to the
   * station they are working. Added by migration 010, defaulting to all three
   * so the flag alone still means what it always did. Granted `SELECT` and
   * deliberately not `UPDATE`, for the same reason as the flag.
   */
  redeem_scopes: string[];

  /**
   * Whether this volunteer may run the raffle draw. Added by migration 011,
   * granted `SELECT` and deliberately not `UPDATE`, for the same reason as
   * `can_redeem`. A separate flag rather than a widening of that one: counter
   * staff and whoever calls the numbers are different people.
   */
  can_draw: boolean;

  /**
   * Whether this volunteer's pass links to `/admin`. Added by migration 022,
   * `SELECT`-only like the flags above. A convenience and not a permission:
   * `/admin` has its own login, which this does not bypass.
   */
  show_admin_link: boolean;

  /**
   * The administrator account this volunteer holds, if any. Added by migration
   * 031, `SELECT`-only like the flags above. A label and not a permission:
   * every admin gate authenticates against `admins` itself. Not a foreign key;
   * a name matching no active account means no admin access.
   */
  admin_username: string | null;

  /**
   * The team this volunteer works on, and their role in it. Added by migration
   * 024, `SELECT`-only like the flags above. Labels for the pass, not
   * permissions; null while unassigned.
   */
  team: string | null;
  team_role: string | null;

  /**
   * When this volunteer should arrive on event day, as pg returns `time`:
   * `HH:MM:SS`, always at second zero. Added by migration 035, `SELECT`-only
   * like the flags above; written through `set_volunteer_permissions`. Not
   * shown on the pass; null for a participant, who cannot hold one.
   */
  checkin_time: string | null;

  checkin_complete: boolean;
  checkin_at: Date | null;
  checkin_number: number | null;

  meal_option: string | null;
  meal_redeemed_at: Date | null;

  drink_option: string | null;
  drink_redeemed_at: Date | null;

  tshirt_size: string | null;
  tshirt_redeemed_at: Date | null;

  /** Volunteers only: `attendees_lunch_volunteer_check` refuses it otherwise. */
  lunch_option: string | null;
  lunch_redeemed_at: Date | null;

  /**
   * Volunteers only: `attendees_tshirt_volunteer_volunteer_check` refuses it
   * otherwise.
   */
  tshirt_volunteer_size: string | null;
  tshirt_volunteer_redeemed_at: Date | null;

  /**
   * When this attendee was retired from the event, or null while they are
   * active. Added by migration 015.
   *
   * A timestamp rather than a flag, for the same reason as the `*_redeemed_at`
   * columns above. **Every read path in attendee.repository.ts filters on it**,
   * so an archived attendee cannot check in, open their pass, be served at a
   * redemption counter or be drawn in the raffle.
   */
  archived_at: Date | null;

  created_at: Date;
  updated_at: Date | null;
}

/** An attendee's own view of their record, in application casing. */
export interface AttendeeProfile {
  ticketCode: string;

  /**
   * Both names ship to the browser rather than one resolved display name: the
   * pass renders whichever applies, and the editor needs to know what it would
   * fall back to if the nickname were cleared.
   */
  attendeeFirstName: string;
  attendeeNickname: string | null;

  checkinNumber: number | null;
  checkinAt: Date | null;

  attendeeRole: AttendeeRole;

  /** Drives the link to the staff surface. The server still gates the page. */
  canRedeem: boolean;

  /** Drives the link to the raffle surface. The server still gates the page. */
  canDraw: boolean;

  /**
   * Drives the link to `/admin`: the manual flag, or a linked active
   * administrator account. Still only a link; `/admin` asks for its own login.
   */
  showAdminLink: boolean;

  /**
   * What the pass labels the volunteer's access as; null for a participant. A
   * label only — every gate re-reads its own permission.
   */
  accessTier: AccessTier | null;

  /**
   * Replace the welcome on a volunteer's pass. Null while unassigned, and
   * always for a participant.
   */
  team: string | null;
  teamRole: string | null;

  mealOption: string | null;
  mealRedeemedAt: Date | null;

  drinkOption: string | null;
  drinkRedeemedAt: Date | null;

  tshirtSize: string | null;
  tshirtRedeemedAt: Date | null;

  /** Always null for a participant. */
  lunchOption: string | null;
  lunchRedeemedAt: Date | null;

  /** Always null for a participant. */
  tshirtVolunteerSize: string | null;
  tshirtVolunteerRedeemedAt: Date | null;

  /**
   * Whether this attendee has answered the questionnaire. Only the fact, from
   * `survey_completions`: nothing links an attendee to their answers.
   */
  surveyCompleted: boolean;
}
