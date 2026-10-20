import {
  getVolunteer,
  listVolunteers,
  setVolunteerPermissions,
  volunteerChanges,
} from './admin.volunteers.repository.ts';
import { accessTier } from '../attendee/attendee.access-tier.ts';
import { NotFoundError } from '../../shared/errors/app-error.ts';

import type { Request } from 'express';

import type { AccessTier } from '../../constants/access-tier.ts';
import type { AdminSession } from '../../types/session.ts';
import type {
  PermissionSnapshot,
  VolunteerChangeRow,
  VolunteerRow,
} from './admin.volunteers.repository.ts';
import type { VolunteerPermissions } from './admin.volunteers.rules.ts';

/** A volunteer as the API and the screen serve them. */
export interface VolunteerView extends VolunteerPermissions {
  attendeeId: string;
  name: string;
  nickname: string | null;
  ticketCode: string;
  adminUsername: string | null;

  /** What the pass displays; `null` is not reachable for a volunteer. */
  tier: AccessTier | null;
}

/** A volunteer with their linked account's state and recent changes. */
export interface VolunteerDetail extends VolunteerView {
  /** The linked account exists and is switched off. */
  adminDisabled: boolean;

  changes: VolunteerChange[];
}

/** One recorded change. */
export interface VolunteerChange {
  before: PermissionSnapshot;
  after: PermissionSnapshot;
  changedAt: Date;

  /** `null` when the administrator's account has since been deleted. */
  changedBy: string | null;
}

/** What a save returns: the stored values, and whether it wrote anything. */
export interface SaveResult {
  volunteer: VolunteerView;
  changed: boolean;
}

/**
 * Maps a stored row to the view, deriving the tier the pass will show.
 *
 * @param row - A volunteer row.
 */
const toView = (row: VolunteerRow): VolunteerView => ({
  attendeeId: row.attendee_id,
  name: row.attendee_name,
  nickname: row.attendee_nickname,
  ticketCode: row.ticket_code,
  canRedeem: row.can_redeem,
  redeemScopes: row.redeem_scopes as VolunteerPermissions['redeemScopes'],
  canDraw: row.can_draw,
  showAdminLink: row.show_admin_link,
  team: row.team,
  teamRole: row.team_role,
  checkinTime: row.checkin_time,
  adminUsername: row.admin_username,
  tier: accessTier({
    attendeeRole: 'volunteer',
    canRedeem: row.can_redeem,
    redeemScopes: row.redeem_scopes,
    canDraw: row.can_draw,
    adminScopes: row.admin_scopes,
  }),
});

/**
 * Maps a history row to its view.
 *
 * @param row - A row of the audit table, with the administrator's username.
 */
const toChange = (row: VolunteerChangeRow): VolunteerChange => ({
  before: row.before,
  after: row.after,
  changedAt: row.changed_at,
  changedBy: row.username,
});

/**
 * An administrator's changes to volunteers' permissions.
 *
 * Gated on `volunteers:write` at its mount, for the reason
 * `AdminRedemptionsService` gives about its own scope.
 */
export class AdminVolunteersService {
  readonly req: Request;

  /**
   * @param req - Request carrying an already-gated admin session.
   */
  constructor(req: Request) {
    this.req = req;
  }

  /**
   * The administrator the change is recorded against.
   *
   * @throws {Error} If the request carries no admin session, which reports a
   *   wiring mistake: the audit row cannot be written without an actor.
   */
  get adminId(): string {
    const session = this.req.session as AdminSession | undefined;

    if (!session?.adminId) {
      throw new Error('AdminVolunteersService requires an admin session');
    }

    return session.adminId;
  }

  /** Every volunteer of the event, with their tier. */
  async list(): Promise<VolunteerView[]> {
    return (await listVolunteers()).map(toView);
  }

  /**
   * One volunteer, with their recent changes.
   *
   * @param attendeeId - Attendee to read.
   * @throws {NotFoundError} If they are not a volunteer of this event.
   */
  async get(attendeeId: string): Promise<VolunteerDetail> {
    const [row, changes] = await Promise.all([
      getVolunteer(attendeeId),
      volunteerChanges(attendeeId),
    ]);

    if (!row) throw new NotFoundError('Volunteer not found');

    return {
      ...toView(row),
      adminDisabled: row.admin_disabled,
      changes: changes.map(toChange),
    };
  }

  /**
   * Saves a volunteer's permissions and reads them back.
   *
   * The values returned are the stored ones, so the caller sees the tier the
   * pass will now show rather than an echo of its request.
   *
   * @param attendeeId - Attendee to change.
   * @param values - The validated permissions.
   * @throws {NotFoundError} If they are not a volunteer of this event.
   */
  async save(
    attendeeId: string,
    values: VolunteerPermissions,
  ): Promise<SaveResult> {
    const adminId = this.adminId;

    const { changed } = await setVolunteerPermissions({
      attendeeId,
      adminId,
      values,
    });

    const row = await getVolunteer(attendeeId);

    if (!row) throw new NotFoundError('Volunteer not found');

    if (changed) {
      this.req.log.info({ adminId, attendeeId }, 'Volunteer permissions saved');
    }

    return { volunteer: toView(row), changed };
  }
}
