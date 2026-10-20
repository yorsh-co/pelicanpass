import { request } from './api.request.ts';

import type { TicketLimitOverview } from '../../../../types/ticket-limit.ts';
import type { DoorOutcome } from '../../../../types/whatsapp-door.ts';

/**
 * The attendees editor's writes.
 *
 * There is no read here, and that is not an omission: the roster and the record
 * form are server-rendered from the query string, so the only thing this
 * surface sends over the wire is a change.
 */

/** What the create and edit forms send. Every field is a string off a form. */
export interface AttendeeFields {
  name: string;
  phone: string;
  role: string;
  mealOption: string;
  drinkOption: string;
  tshirtSize: string;
  lunchOption: string;
  tshirtVolunteerSize: string;

  /** Create only. Blank asks the server to generate one. */
  ticketCode?: string;

  /** Whether to send the door WhatsApp message, on a form that offers it. */
  sendWhatsapp?: boolean;
}

/** What creating one answers with. */
export interface CreatedAttendee {
  attendeeId: string;
  ticketCode: string;

  /** The ticket limit with this attendee counted, or `null` when there is none. */
  limit: TicketLimitOverview | null;

  /** The door message's outcome, or `null` when none was asked for. */
  whatsapp: DoorOutcome | null;
}

/**
 * Deadline for a save that may send the door message.
 *
 * With the message ticked, the server awaits the Meta send
 * (`WHATSAPP_REQUEST_TIMEOUT`, 10 s) after the database work, so the default
 * deadline would cut off saves that are going to succeed. The admin surface is
 * low volume and never shed, so the longer wait costs nothing.
 */
const DOOR_MESSAGE_TIMEOUT_MS = 30_000;

/** The response envelope, with everything optional — see api.raffle.ts. */
interface Envelope<T> {
  data?: Partial<T>;
}

/**
 * Creates an attendee.
 *
 * @param fields - Values as typed. Every rule is the server's.
 * @param idempotencyKey - The same for every attempt at one create, so a
 *   re-tap after a timeout replays the attendee the first attempt made rather
 *   than adding a second.
 * @returns The new attendee's ID and the code they were issued.
 * @throws {ApiError} `VALIDATION_ERROR` on a malformed field, `CONFLICT` when a
 *   typed ticket code is already in use or a hard ticket limit is reached, or `CONFLICT` with
 *   `requestInProgress` while an attempt with the same key is still running.
 */
export const create = async (
  fields: AttendeeFields,
  idempotencyKey: string,
): Promise<CreatedAttendee> => {
  const res = await request<Envelope<CreatedAttendee>>(
    '/api/v1/admin/attendees',
    {
      method: 'POST',
      json: fields,
      headers: { 'Idempotency-Key': idempotencyKey },
      timeoutMs: DOOR_MESSAGE_TIMEOUT_MS,
    },
  );

  const data = res.data;

  if (typeof data?.attendeeId !== 'string') {
    throw new Error('Create returned no attendee');
  }

  return {
    attendeeId: data.attendeeId,
    ticketCode: data.ticketCode ?? '',
    limit: data.limit ?? null,
    whatsapp: data.whatsapp ?? null,
  };
};

/** What saving one answers with, of what the form reads. */
export interface SavedAttendee {
  /** The door message's outcome, or `null` when none was asked for. */
  whatsapp: DoorOutcome | null;
}

/**
 * Replaces the editable fields of one attendee.
 *
 * @param attendeeId - Attendee to update.
 * @param fields - Values as typed.
 * @returns What became of the door message.
 * @throws {ApiError} `CONFLICT` when the role would change after check-in, or a
 *   collected item would be cleared.
 */
export const update = async (
  attendeeId: string,
  fields: AttendeeFields,
): Promise<SavedAttendee> => {
  const res = await request<Envelope<SavedAttendee>>(
    `/api/v1/admin/attendees/${attendeeId}`,
    {
      method: 'PATCH',
      json: fields,
      timeoutMs: DOOR_MESSAGE_TIMEOUT_MS,
    },
  );

  return { whatsapp: res.data?.whatsapp ?? null };
};

/**
 * Retires an attendee from the event, or brings one back.
 *
 * Two paths rather than a flag, matching the two endpoints.
 *
 * @param attendeeId - Attendee to archive.
 */
export const archive = async (attendeeId: string): Promise<void> => {
  await request(`/api/v1/admin/attendees/${attendeeId}/archive`, {
    method: 'POST',
  });
};

/**
 * Brings an archived attendee back.
 *
 * @param attendeeId - Attendee to bring back.
 * @returns The ticket limit with this attendee counted, or `null` when there
 *   is none.
 * @throws {ApiError} `CONFLICT` with `ticketLimitReached` when a hard limit has
 *   no room left.
 */
export const restore = async (
  attendeeId: string,
): Promise<TicketLimitOverview | null> => {
  const res = await request<Envelope<{ limit: TicketLimitOverview | null }>>(
    `/api/v1/admin/attendees/${attendeeId}/restore`,
    { method: 'POST' },
  );

  return res.data?.limit ?? null;
};

/**
 * Removes the display name an attendee chose for their pass.
 *
 * **No `json` option, and none may be added.** Passing one would set
 * `Content-Type: application/json`, and `requireSupportedContentType` calls
 * `req.is()`, which reports false for a request carrying no body *regardless*
 * of the type it declares — so the header turns this into a 415. Measured, not
 * guessed. The absence of a body is the whole point of using `DELETE` here.
 *
 * @param attendeeId - Attendee whose nickname is cleared.
 */
export const clearNickname = async (attendeeId: string): Promise<void> => {
  await request(`/api/v1/admin/attendees/${attendeeId}/nickname`, {
    method: 'DELETE',
  });
};
