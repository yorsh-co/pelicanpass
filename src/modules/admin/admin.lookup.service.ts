import { getAttendeeForEdit } from './admin.attendees.repository.ts';

import { assertCheckinOpen } from '../checkin/checkin.window.ts';
import { completeCheckin } from '../attendee/attendee.repository.ts';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error.ts';

import type { Request } from 'express';

import type { AdminSession } from '../../types/session.ts';

/**
 * Marking an attendee present by hand, for the volunteer quick lookup and the
 * attendee editor.
 *
 * **This is the one surface that stands in for the check-in flow's own
 * proofs.** An attendee normally supplies the last four digits of their phone
 * (`verifyAttendee`, identity) and scans the poster (`validateQrToken`,
 * presence). A support volunteer using this endpoint has substituted their own
 * judgement for both, which is exactly what `checkin:write` grants and why it
 * is a separate scope from `attendees:read` — someone holding only the latter
 * gets a lookup that reads and cannot mark.
 *
 * It is a separate service from {@link AdminAttendeesService} rather than a
 * sixth method on it, because that class is gated on `attendees:write` at its
 * mount and its own header lists marking someone present among the things it
 * deliberately does not do.
 *
 * Messages are pt-BR, matching the editor's service and for the same reason:
 * one `ConflictError` code covers several different refusals, so the operator
 * has to read the message rather than branch on the code.
 */

/** What {@link AdminLookupService.markPresent} answers with. */
export interface MarkPresentResult {
  /** The arrival number, or `null` — volunteers are not issued one. */
  checkinNumber: number | null;

  /** When the check-in landed. Their original time, if they already had one. */
  checkinAt: Date;

  /**
   * Whether the row was already complete before this call.
   *
   * `completeCheckin` is idempotent and answers the same shape either way, so
   * this is the only moment the difference is observable. The screen uses it to
   * say "already present" instead of claiming to have done something.
   */
  alreadyCheckedIn: boolean;
}

/** The quick lookup's one privileged action, behind `checkin:write`. */
export class AdminLookupService {
  readonly req: Request;

  /**
   * Takes the request alone, like {@link AdminAttendeesService}.
   *
   * `req` is not only for logging here: `assertCheckinOpen` reads the landing
   * bypass cookie off it, so a closed window can still be rehearsed with
   * `LANDING_BYPASS_TOKEN` the same way the door can.
   *
   * @param req - Request carrying an already-gated admin session.
   */
  constructor(req: Request) {
    this.req = req;
  }

  /** The administrator the check-in is logged against. */
  get adminId(): string | undefined {
    const session = this.req.session as AdminSession | undefined;

    return session?.adminId ?? undefined;
  }

  /**
   * Completes an attendee's check-in on their behalf.
   *
   * Safe to call twice. `completeCheckin` locks the row, returns the number it
   * already issued rather than drawing a second from the sequence, and this
   * reports which of the two happened — so a double-tap at a door costs
   * nothing.
   *
   * **The result deliberately does not carry the attendee row**, which every
   * write in `admin.attendees.controller.ts` does return. `AttendeeAdminRow`
   * projects `attendee_phone`, and handing the full number back to a client is
   * the one thing the screen calling this is built to avoid. Three fields are
   * what the caller needs.
   *
   * @param attendeeId - Attendee to admit.
   * @returns Their number, the time, and whether they were already present.
   * @throws {NotFoundError} If no attendee under this event holds that ID.
   * @throws {ConflictError} If the attendee is archived.
   * @throws {CheckinNotOpenError} If their audience's window has not opened.
   */
  async markPresent(attendeeId: string): Promise<MarkPresentResult> {
    const attendee = await getAttendeeForEdit(attendeeId);

    if (!attendee) {
      throw new NotFoundError('Attendee not found', {
        reason: 'attendeeNotFound',
      });
    }

    // getAttendeeForEdit does not filter archived rows — the editor has to be
    // able to open one to restore it — so the refusal belongs here. Left to
    // completeCheckin's null below it would read as "not found", which sends
    // somebody looking for a typo that is not there.
    if (attendee.archived_at !== null) {
      throw new ConflictError('Attendee is archived', {
        reason: 'attendeeArchived',
      });
    }

    // The role comes off the row, never off the request: checkin.window.ts
    // makes the same point about `?audience=`, which only selects copy.
    assertCheckinOpen(attendee.attendee_role, this.req);

    const alreadyCheckedIn = attendee.checkin_complete;

    const completed = await completeCheckin(attendee.ticket_code);

    // Archived between the read above and the lock inside completeCheckin.
    if (!completed) {
      throw new ConflictError('Attendee is archived', {
        reason: 'attendeeArchived',
      });
    }

    this.req.log.info(
      {
        adminId: this.adminId,
        attendeeId,
        checkinNumber: completed.checkinNumber,
        alreadyCheckedIn,
        source: 'admin',
      },
      'Attendee marked present',
    );

    return { ...completed, alreadyCheckedIn };
  }
}
