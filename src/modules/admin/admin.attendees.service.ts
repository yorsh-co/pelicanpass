import pkg from 'pg';

import {
  clearAttendeeNickname,
  createAttendee,
  getAttendeeForEdit,
  setAttendeeArchived,
  updateAttendee,
} from './admin.attendees.repository.ts';
import {
  readName,
  readOption,
  readPhone,
  readRole,
  readTypedTicketCode,
  readVolunteerOnlyOption,
} from './admin.attendees.rules.ts';
import { buildTicketCode } from './admin.ticket-code.ts';
import { AdminTicketLimitService } from './admin.ticket-limit.service.ts';
import { AdminWhatsappDoorService } from './admin.whatsapp-door.service.ts';
import { withTransaction } from './admin.whatsapp.repository.ts';

import {
  WALK_IN_TICKET_PREFIX,
  VOLUNTEER_TICKET_PREFIX,
} from '../../constants/ticket.ts';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error.ts';

import type { Request } from 'express';

import type {
  AttendeeAdminRow,
  AttendeeCreateInput,
} from './admin.attendees.repository.ts';
import type { RedemptionItem } from '../../constants/pass.ts';
import type { AttendeeRole } from '../../types/attendee.ts';
import type { AdminSession } from '../../types/session.ts';
import type { TicketLimitOverview } from '../../types/ticket-limit.ts';
import type { DoorOutcome } from '../../types/whatsapp-door.ts';

const { DatabaseError } = pkg;

/**
 * Creating, editing and retiring attendees, and the rules that govern all three.
 *
 * Every rule lives here, or in `admin.attendees.rules.ts` where the roster
 * import shares it, rather than in `admin.attendees.repository.ts`, which
 * writes what it is given — the arrangement `updateAttendeeNickname` already
 * describes for the attendee's own surface.
 *
 * **Every refusal carries a `reason`.** Messages are English diagnostics, as
 * elsewhere, and the admin client renders its own text. The code alone is not
 * enough here: `ConflictError` carries one code for several different
 * refusals, so "that code is taken" and "the role cannot change now" are told
 * apart by `details.reason` (see `types/admin-refusal.ts`).
 *
 * Deliberately absent, so none of it is added by reflex: marking someone present
 * by hand, which is `checkin:write` and `AdminLookupService`'s job (the editor
 * page calls that endpoint rather than this service); reversing a redemption,
 * which belongs to the redemptions viewer and fights an append-only
 * audit trail; and writing `can_redeem`, `redeem_scopes` or `can_draw`, which
 * migrations 008, 010 and 011 grant `SELECT` on and deliberately not `UPDATE`.
 */

/**
 * Attempts a generated code gets before the request fails.
 *
 * 27^5 is 14,348,907 against a roster of hundreds, so one collision is
 * surprising and a second is not chance. Failing loudly is the point: a silent
 * fourth attempt would hide whatever is actually wrong.
 */
const MAX_GENERATE_ATTEMPTS = 3;

/**
 * The unique constraint a duplicate ticket code violates.
 *
 * Matched by name rather than on `23505` alone. `attendees` carries four unique
 * constraints — the primary key, this one, `attendees_checkin_number_key` and
 * `attendees_ticket_link_token_key` — and answering "that code is taken" to a
 * link-token collision would put a reassuring message on something that, at 128
 * bits of randomness, does not happen by chance.
 */
const TICKET_CODE_CONSTRAINT = 'attendees_ticket_code_key';

/**
 * Builds a ticket code for a new attendee.
 *
 * @param role - Which prefix the code carries.
 * @returns A six-character code: `v` for a volunteer, `d` for a participant,
 *   then five random characters from the alphabet in `admin.ticket-code.ts`.
 */
export const generateTicketCode = (role: AttendeeRole): string => {
  const prefix =
    role === 'volunteer' ? VOLUNTEER_TICKET_PREFIX : WALK_IN_TICKET_PREFIX;

  return buildTicketCode(prefix);
};

/**
 * Whether an error is a duplicate ticket code and not some other collision.
 *
 * The first place in `src/` to read a Postgres error code, so it is worth doing
 * properly: `pg` exports `DatabaseError` itself, which makes this a real
 * `instanceof` rather than an `any` cast onto a shape that might not be there.
 *
 * @param err - Whatever the repository threw.
 */
const isTicketCodeCollision = (err: unknown): boolean =>
  err instanceof DatabaseError &&
  err.code === '23505' &&
  err.constraint === TICKET_CODE_CONSTRAINT;

/** What the create endpoint accepts, before any of it is trusted. */
export interface AttendeeCreateRequest {
  ticketCode?: string | undefined;
  name: string;
  phone: string;
  role: string | undefined;
  mealOption?: string | undefined;
  drinkOption?: string | undefined;
  tshirtSize?: string | undefined;
  lunchOption?: string | undefined;
  tshirtVolunteerSize?: string | undefined;

  /** Whether the operator asked for the door message. */
  sendWhatsapp?: boolean;
}

/** What the edit endpoint accepts. The ticket code is not editable. */
export type AttendeeUpdateRequest = Omit<AttendeeCreateRequest, 'ticketCode'>;

/** What saving an attendee answers with. */
export type AttendeeUpdated = AttendeeAdminRow & {
  /** The door message's outcome, or `null` when the operator did not ask. */
  whatsapp: DoorOutcome | null;
};

/** What creating an attendee answers with. */
export interface AttendeeCreated {
  attendeeId: string;
  ticketCode: string;

  /**
   * The ticket limit as it stands with this attendee counted, or `null` when
   * there is no limit.
   */
  limit: TicketLimitOverview | null;

  /** The door message's outcome, or `null` when the operator did not ask. */
  whatsapp: DoorOutcome | null;
}

/** What restoring an attendee answers with. */
export type AttendeeRestored = AttendeeAdminRow & {
  /**
   * The ticket limit as it stands with this attendee counted, or `null` when
   * there is no limit.
   */
  limit: TicketLimitOverview | null;
};

/** Operations behind `attendees:write`. */
export class AdminAttendeesService {
  readonly req: Request;

  /**
   * Takes the request alone.
   *
   * `AdminService` and `StaffService` take `{ req, res }` because they mint and
   * destroy sessions. Nothing here touches a cookie, so carrying `res` would be
   * a parameter that exists only for symmetry.
   *
   * @param req - Request carrying an already-gated admin session.
   */
  constructor(req: Request) {
    this.req = req;
  }

  /** The administrator every write is logged against. */
  get adminId(): string | undefined {
    const session = this.req.session as AdminSession | undefined;

    return session?.adminId ?? undefined;
  }

  /**
   * Creates an attendee, then sends the door message if the operator asked.
   *
   * The message goes only once the attendee is committed, and its outcome never
   * undoes or fails the create: somebody standing at the door is let in whether
   * or not WhatsApp cooperates.
   *
   * @param input - Values as received from the request body.
   * @returns The new attendee's ID and code, the ticket limit with them
   *   counted, and what became of the message.
   * @throws {ValidationError} If any field is malformed.
   * @throws {ConflictError} If a typed code is already in use, or the ticket
   *   limit is hard and reached.
   * @throws {Error} If a generated code collides on every attempt.
   */
  async create(input: AttendeeCreateRequest): Promise<AttendeeCreated> {
    const created = await this.#insert(input);

    const whatsapp = input.sendWhatsapp
      ? await new AdminWhatsappDoorService(this.req).send(created.attendeeId)
      : null;

    return { ...created, whatsapp };
  }

  /**
   * Inserts the attendee.
   *
   * A blank code is generated, and a generated collision is retried up to
   * {@link MAX_GENERATE_ATTEMPTS} times. **A typed collision is never retried**
   * — quietly issuing a different code than the operator asked for is worse
   * than refusing, because they are about to write it on something.
   *
   * @param input - Values as received from the request body.
   * @returns The new attendee's ID and code, and the ticket limit with them
   *   counted.
   */
  async #insert(
    input: AttendeeCreateRequest,
  ): Promise<Omit<AttendeeCreated, 'whatsapp'>> {
    const role = readRole(input.role);

    const fields = {
      attendeeName: readName(input.name),
      attendeePhone: readPhone(input.phone),
      attendeeRole: role,
      mealOption: readOption(input.mealOption, 'meal', role, null),
      drinkOption: readOption(input.drinkOption, 'drink', role, null),
      tshirtSize: readOption(input.tshirtSize, 'tshirt', role, null),
      lunchOption: readVolunteerOnlyOption(
        input.lunchOption,
        'lunch',
        role,
        null,
      ),
      tshirtVolunteerSize: readVolunteerOnlyOption(
        input.tshirtVolunteerSize,
        'tshirt_volunteer',
        role,
        null,
      ),
    };

    const typed = (input.ticketCode ?? '').trim();

    if (typed) {
      const ticketCode = readTypedTicketCode(typed, role);

      try {
        return this.#created(await this.#attempt(fields, ticketCode));
      } catch (err) {
        if (isTicketCodeCollision(err)) {
          // Never the driver's message: its `detail` names the colliding code,
          // which may belong to another event's roster this application cannot
          // otherwise see.
          throw new ConflictError('Ticket code taken', {
            reason: 'ticketCodeTaken',
          });
        }

        throw err;
      }
    }

    for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt += 1) {
      try {
        return this.#created(
          await this.#attempt(fields, generateTicketCode(role)),
        );
      } catch (err) {
        if (!isTicketCodeCollision(err)) throw err;

        this.req.log.warn(
          { adminId: this.adminId, attempt },
          'Generated ticket code collided',
        );
      }
    }

    throw new Error(
      `Could not generate a free ticket code in ${String(MAX_GENERATE_ATTEMPTS)} attempts`,
    );
  }

  /**
   * One insert attempt: the ticket limit's guard and the `INSERT` in a single
   * transaction, so the count the guard read is the count the insert joins.
   *
   * A collision rolls the transaction back, releasing the lock, before the
   * caller decides whether to retry. The warning event is recorded after the
   * commit, so an attempt that rolled back reports nothing.
   *
   * @param fields - Validated values, without the code.
   * @param ticketCode - The code this attempt inserts.
   */
  async #attempt(
    fields: Omit<AttendeeCreateInput, 'ticketCode'>,
    ticketCode: string,
  ): Promise<Omit<AttendeeCreated, 'whatsapp'>> {
    const limits = new AdminTicketLimitService(this.req);

    const { created, limit } = await withTransaction(async (client) => {
      const limit = await limits.guard(client, fields.attendeeRole, ticketCode);

      return {
        created: await createAttendee({ ...fields, ticketCode }, client),
        limit,
      };
    });

    limits.recordExceeded(limit, fields.attendeeRole, created.ticketCode);

    return { ...created, limit };
  }

  /**
   * Replaces the editable fields of one attendee.
   *
   * **Reads the record first, at save time.** Two rules need to know what it
   * says now, and reading here rather than at form load is what closes the
   * window that actually matters: an administrator opens the form, the attendee
   * walks through the door, and the save arrives minutes later.
   *
   * The remaining race — a check-in landing between this read and the write — is
   * accepted. Closing it would mean a conditional `UPDATE` plus a follow-up
   * `SELECT` to tell "not found" from "refused", which is the shape
   * `redeemItem` uses, for a window a check-in has to land inside.
   *
   * @param attendeeId - Attendee to update.
   * @param input - Values as received from the request body.
   * @returns The updated row, and what became of the door message.
   * @throws {ValidationError} If any field is malformed.
   * @throws {NotFoundError} If no attendee has that ID under this event.
   * @throws {ConflictError} If the role would change after check-in, or a
   *   redeemed entitlement would be cleared.
   */
  async update(
    attendeeId: string,
    input: AttendeeUpdateRequest,
  ): Promise<AttendeeUpdated> {
    const current = await getAttendeeForEdit(attendeeId);

    if (!current)
      throw new NotFoundError('Attendee not found', {
        reason: 'attendeeNotFound',
      });

    const role = readRole(input.role);

    if (role !== current.attendee_role && current.checkin_complete) {
      throw new ConflictError('Role locked after check-in', {
        reason: 'roleLocked',
      });
    }

    const next = {
      attendeeName: readName(input.name),
      attendeePhone: readPhone(input.phone),
      attendeeRole: role,
      mealOption: readOption(input.mealOption, 'meal', role, {
        value: current.meal_option,
        role: current.attendee_role,
      }),
      drinkOption: readOption(input.drinkOption, 'drink', role, {
        value: current.drink_option,
        role: current.attendee_role,
      }),
      tshirtSize: readOption(input.tshirtSize, 'tshirt', role, {
        value: current.tshirt_size,
        role: current.attendee_role,
      }),
      lunchOption: readVolunteerOnlyOption(input.lunchOption, 'lunch', role, {
        value: current.lunch_option,
        role: current.attendee_role,
      }),
      tshirtVolunteerSize: readVolunteerOnlyOption(
        input.tshirtVolunteerSize,
        'tshirt_volunteer',
        role,
        { value: current.tshirt_volunteer_size, role: current.attendee_role },
      ),
    };

    this.#assertRedeemedNotCleared(current, next);

    const updated = await updateAttendee(attendeeId, next);

    if (!updated)
      throw new NotFoundError('Attendee not found', {
        reason: 'attendeeNotFound',
      });

    this.req.log.info(
      {
        adminId: this.adminId,
        attendeeId,
        fields: changedFields(current, next),
      },
      'Attendee updated',
    );

    // After the save, so the message goes to the number just written. A
    // corrected number is saved whatever becomes of the message.
    const whatsapp = input.sendWhatsapp
      ? await new AdminWhatsappDoorService(this.req).send(attendeeId)
      : null;

    return { ...updated, whatsapp };
  }

  /**
   * Retires an attendee from the event, or brings them back.
   *
   * Allowed whether or not they have checked in: a duplicate registration is
   * usually found after somebody has already walked through the door.
   *
   * Archiving frees a ticket, so it is never refused. Restoring takes one back,
   * so it passes the ticket limit's guard in the same transaction as the write,
   * reading the row's role and code there rather than trusting an earlier read.
   *
   * @param attendeeId - Attendee to archive or restore.
   * @param archived - Whether they should be archived.
   * @returns The updated row and, on a restore, the ticket limit with them
   *   counted (`null` when archiving or when there is no limit).
   * @throws {NotFoundError} If no attendee has that ID under this event.
   * @throws {ConflictError} On a restore, if the ticket limit is hard and
   *   reached.
   */
  async setArchived(
    attendeeId: string,
    archived: boolean,
  ): Promise<AttendeeRestored> {
    const limits = new AdminTicketLimitService(this.req);

    const { updated, limit, current } = await withTransaction(
      async (client) => {
        if (archived) {
          return {
            updated: await setAttendeeArchived(attendeeId, true, client),
            limit: null,
            current: null,
          };
        }

        // Missing is not this method's refusal to make: the write below finds
        // no row either and answers `attendeeNotFound`.
        const current = await getAttendeeForEdit(attendeeId, client);

        // Already active: restoring changes nothing, so it must not be
        // refused for a slot it is not taking.
        const limit = current?.archived_at
          ? await limits.guard(
              client,
              current.attendee_role,
              current.ticket_code,
            )
          : null;

        return {
          updated: await setAttendeeArchived(attendeeId, false, client),
          limit,
          current,
        };
      },
    );

    if (!updated)
      throw new NotFoundError('Attendee not found', {
        reason: 'attendeeNotFound',
      });

    this.req.log.info(
      { adminId: this.adminId, attendeeId, archived },
      archived ? 'Attendee archived' : 'Attendee restored',
    );

    if (current) {
      limits.recordExceeded(limit, current.attendee_role, current.ticket_code);
    }

    return { ...updated, limit };
  }

  /**
   * Removes the display name an attendee chose for their pass.
   *
   * Clear only, never set. The terms of use promise the team can remove a
   * nickname; renaming somebody is a different thing entirely, and this is the
   * gap `docs/operations/deployment.md` records as a `psql` command today.
   *
   * @param attendeeId - Attendee to clear.
   * @returns The updated row.
   * @throws {NotFoundError} If no attendee has that ID under this event.
   */
  async clearNickname(attendeeId: string): Promise<AttendeeAdminRow> {
    const updated = await clearAttendeeNickname(attendeeId);

    if (!updated)
      throw new NotFoundError('Attendee not found', {
        reason: 'attendeeNotFound',
      });

    this.req.log.info(
      { adminId: this.adminId, attendeeId },
      'Attendee nickname cleared',
    );

    return updated;
  }

  /**
   * Refuses to clear an entitlement somebody has already collected.
   *
   * Clearing means the record then says they were never entitled to it, while a
   * `redemptions` row says they collected it — the audit trail and the roster
   * disagreeing about the same person.
   *
   * **Changing** a value is allowed, and that asymmetry is deliberate:
   * `redemptions` records the *item* rather than the value, so correcting a
   * shirt size after it was handed over leaves the audit row true.
   *
   * @param current - The record as stored.
   * @param next - The values about to replace it.
   * @throws {ConflictError} If a redeemed entitlement would be cleared.
   */
  #assertRedeemedNotCleared(
    current: AttendeeAdminRow,
    next: {
      mealOption: string | null;
      drinkOption: string | null;
      tshirtSize: string | null;
      lunchOption: string | null;
      tshirtVolunteerSize: string | null;
    },
  ): void {
    const cleared = [
      { value: next.mealOption, at: current.meal_redeemed_at, item: 'meal' },
      { value: next.drinkOption, at: current.drink_redeemed_at, item: 'drink' },
      {
        value: next.tshirtSize,
        at: current.tshirt_redeemed_at,
        item: 'tshirt',
      },
      { value: next.lunchOption, at: current.lunch_redeemed_at, item: 'lunch' },
      {
        value: next.tshirtVolunteerSize,
        at: current.tshirt_volunteer_redeemed_at,
        item: 'tshirt_volunteer',
      },
    ].find((entry) => entry.value === null && entry.at !== null);

    if (cleared) {
      throw new ConflictError(`Cannot clear redeemed ${cleared.item}`, {
        reason: 'itemAlreadyRedeemed',
        item: cleared.item as RedemptionItem,
      });
    }
  }

  /** Logs a creation and returns it unchanged. */
  #created<T extends { attendeeId: string; ticketCode: string }>(
    created: T,
  ): T {
    this.req.log.info(
      {
        adminId: this.adminId,
        attendeeId: created.attendeeId,
        ticketCode: created.ticketCode,
      },
      'Attendee created',
    );

    return created;
  }
}

/**
 * Which columns a save actually changed, by name.
 *
 * Names and never values: `docs/security/data-retention.md` records that request logs
 * carry no name, phone number or ticket code, and an editor is the first code
 * path with an obvious excuse to break that.
 *
 * The ticket code is logged on creation and only there — it is issued at that
 * moment and nowhere else, and a creation is the one event where knowing which
 * code was minted is worth more than the line costs.
 *
 * @param current - The record as stored.
 * @param next - The values replacing it.
 */
const changedFields = (
  current: AttendeeAdminRow,
  next: {
    attendeeName: string;
    attendeePhone: string;
    attendeeRole: AttendeeRole;
    mealOption: string | null;
    drinkOption: string | null;
    tshirtSize: string | null;
    lunchOption: string | null;
    tshirtVolunteerSize: string | null;
  },
): string[] =>
  [
    ['attendee_name', current.attendee_name !== next.attendeeName],
    ['attendee_phone', current.attendee_phone !== next.attendeePhone],
    ['attendee_role', current.attendee_role !== next.attendeeRole],
    ['meal_option', current.meal_option !== next.mealOption],
    ['drink_option', current.drink_option !== next.drinkOption],
    ['tshirt_size', current.tshirt_size !== next.tshirtSize],
    ['lunch_option', current.lunch_option !== next.lunchOption],
    [
      'tshirt_volunteer_size',
      current.tshirt_volunteer_size !== next.tshirtVolunteerSize,
    ],
  ]
    .filter(([, changed]) => changed)
    .map(([name]) => String(name));
