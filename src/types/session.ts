import type { AttendeeRole } from './attendee.ts';
import type {
  CheckinFailedAttempts,
  CheckinProgress,
  CheckinStep,
} from './checkin.ts';

/**
 * Every timestamp on a session is epoch milliseconds, not a Date.
 *
 * Sessions are persisted to Redis as JSON, so a Date would come back as a
 * string on the next request. session.service.js writes createdAt/updatedAt
 * with Date.now() on create and on every save, and the check-in flow does the
 * same for its per-step timestamps.
 */
type EpochMs = number;

/** Ticket details, populated at the `ticket` step. */
export interface CheckinTicket {
  ticketCode: string;
  timestamp: EpochMs;
}

/**
 * Timing of the `verification` step.
 *
 * Deliberately holds nothing derived from the phone number. The code is checked
 * against the attendee row at the moment it is submitted, so a session dump has
 * nothing to attack — see `verifyAttendee` in checkin.service.ts.
 */
export interface CheckinVerification {
  timestamp: EpochMs;
}

/** Scanned QR details, populated at the `qr` step. */
export interface CheckinQr {
  qrToken: string;
  timestamp: EpochMs;
}

/** Masked attendee details shown back to the browser during check-in. */
export interface AttendeePreview {
  ticketCode: string;
  name: string;
  phoneStart: string;
}

/**
 * State of an in-progress check-in, keyed by the check-in session cookie.
 *
 * A session is created empty and filled in as the attendee advances, so most
 * fields are nullable or partial until the step that populates them runs. The
 * four nested objects start as `{}` and are spread unconditionally by
 * `applyStep`, so they are always present but not always complete.
 */
export interface CheckinSession {
  type: 'checkin';
  version: number;

  progress: CheckinProgress;
  currentStep: CheckinStep;
  source: 'direct' | 'ticket' | 'qr';

  /** Populated at the `ticket` step. */
  attendeeId: string | null;
  /** Populated at the `qr` step. */
  eventId: string | null;
  /** Populated at the `ticket` step. */
  attendeeRole: AttendeeRole | null;

  checkinAt: EpochMs | null;
  checkinNumber: number | null;
  checkinComplete: boolean | null;

  ticket: Partial<CheckinTicket>;
  verification: Partial<CheckinVerification>;
  qr: Partial<CheckinQr>;
  attendeePreview: Partial<AttendeePreview>;

  failedAttempts: CheckinFailedAttempts;
  captchaRequired: boolean;

  ua: string;

  updatedAt: EpochMs;
  createdAt: EpochMs;
}

/**
 * Session issued once an attendee has completed check-in.
 *
 * `attendeeId` and `attendeeRole` are null between `attendeeSession.create`
 * and the `persist` that immediately follows it, because the session adapter
 * only passes the request to its factory.
 */
export interface AttendeeSession {
  type: 'attendee';
  version: number;

  attendeeId: string | null;
  attendeeRole: AttendeeRole | null;

  ua: string;

  updatedAt: EpochMs;
  createdAt: EpochMs;
}

/**
 * Session issued to a signed-in administrator.
 *
 * `adminId` and `username` are nullable because the session factory only
 * receives the request and cannot know either. `AdminService.login` supplies
 * both through `create`'s overrides, so a stored admin session always carries
 * them — a null one would mean something other than the login path minted it.
 *
 * **The scopes are deliberately absent.** They are read from Postgres on every
 * gated request by `requireAdminScope`, so standing an administrator down or
 * narrowing what they may touch takes effect on their next action rather than
 * when their session expires — the same argument `requireRedeemPermission`
 * makes for volunteers. A scope cached here would be a permission that cannot
 * be withdrawn.
 */
export interface AdminSession {
  type: 'admin';
  version: number;

  adminId: string | null;
  /** Carried for the page header and the audit trail, never for a decision. */
  username: string | null;

  ua: string;

  updatedAt: EpochMs;
  createdAt: EpochMs;
}

/** Any session this application issues. Discriminated on `type`. */
export type Session = CheckinSession | AttendeeSession | AdminSession;

/** Discriminator values for {@link Session}, also used as cookie-name keys. */
export type SessionType = 'checkin' | 'attendee' | 'admin';
