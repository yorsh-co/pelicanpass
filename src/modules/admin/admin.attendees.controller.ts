import type { RequestHandler, Request } from 'express';

import { AdminAttendeesService } from './admin.attendees.service.ts';

import { ValidationError } from '../../shared/errors/app-error.ts';
import {
  readBooleanField,
  readStringField,
} from '../../shared/utils/request-body.ts';
import { isUuid } from '../../shared/utils/uuid.ts';

import type {
  AttendeeCreateRequest,
  AttendeeUpdateRequest,
} from './admin.attendees.service.ts';

/**
 * The attendees editor's write endpoints.
 *
 * Reads are not here: the roster is server-rendered from a submitted form, so
 * the only thing crossing this API is a change. That is also what keeps the
 * screen inside `adminSessionLimiter`'s 20 requests per minute — see the note
 * in `admin.attendees.routes.ts`.
 *
 * Refusals carry a `reason`, as in the service, because one `ConflictError`
 * code covers several different refusals.
 */

/**
 * Reads and checks the attendee this request names.
 *
 * A `ValidationError` rather than a `NotFoundError`, so that "this is not an
 * ID" and "no attendee has this ID" stay separable in a log line. The rendered
 * roster asks `isUuid` the same question and redirects instead.
 *
 * A helper rather than a middleware: four call sites, and a call at the top of
 * the handler is visible where a mount would have to be remembered.
 *
 * @param req - Request carrying the route parameter.
 * @throws {ValidationError} If the parameter is absent, repeated, or not a
 *   UUID.
 */
const readAttendeeId = (req: Request): string => {
  const attendeeId = req.params.attendeeId;

  if (!isUuid(attendeeId)) {
    throw new ValidationError('Invalid attendee ID', {
      reason: 'invalidAttendee',
    });
  }

  return attendeeId;
};

/**
 * Reads the fields both the create and the edit forms carry.
 *
 * Everything is passed through untrusted — the service owns every rule, and
 * nothing here decides whether a value is acceptable.
 *
 * @param body - Parsed request body, or whatever Express left in its place.
 */
const readAttendeeFields = (body: unknown): AttendeeUpdateRequest => ({
  name: readStringField(body, 'name') ?? '',
  phone: readStringField(body, 'phone') ?? '',
  role: readStringField(body, 'role'),
  mealOption: readStringField(body, 'mealOption'),
  drinkOption: readStringField(body, 'drinkOption'),
  lunchOption: readStringField(body, 'lunchOption'),
  tshirtSize: readStringField(body, 'tshirtSize'),
  tshirtVolunteerSize: readStringField(body, 'tshirtVolunteerSize'),
  // Absent is no: a client that does not know about the door message must
  // not spend money by omission.
  sendWhatsapp: readBooleanField(body, 'sendWhatsapp') ?? false,
});

/** Creates an attendee, generating a ticket code when none was typed. */
export const create: RequestHandler = async (req, res, next) => {
  try {
    const input: AttendeeCreateRequest = {
      ...readAttendeeFields(req.body),
      ticketCode: readStringField(req.body, 'ticketCode'),
    };

    const service = new AdminAttendeesService(req);

    res.json({
      success: true,
      code: 'ATTENDEE_CREATED',
      data: await service.create(input),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Replaces the editable fields of one attendee.
 *
 * Every field is sent on every save, so this is a replacement rather than a
 * merge. `PATCH` still fits: the request replaces the part of the record the
 * form owns and leaves the check-in and redemption columns alone, which is the
 * distinction that matters here.
 */
export const update: RequestHandler = async (req, res, next) => {
  try {
    const attendeeId = readAttendeeId(req);

    const service = new AdminAttendeesService(req);

    res.json({
      success: true,
      code: 'ATTENDEE_UPDATED',
      data: await service.update(attendeeId, readAttendeeFields(req.body)),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Retires an attendee from the event.
 *
 * Its own endpoint rather than one taking `{ archived: boolean }`, together
 * with {@link restore}. A boolean body would need a `readBooleanField` in
 * `shared/utils/request-body.ts` for a single consumer; two routes that carry
 * no body at all are less code and each says what it does.
 */
export const archive: RequestHandler = async (req, res, next) => {
  try {
    const attendeeId = readAttendeeId(req);

    const service = new AdminAttendeesService(req);

    res.json({
      success: true,
      code: 'ATTENDEE_ARCHIVED',
      data: await service.setArchived(attendeeId, true),
    });
  } catch (err) {
    next(err);
  }
};

/** Brings an archived attendee back. */
export const restore: RequestHandler = async (req, res, next) => {
  try {
    const attendeeId = readAttendeeId(req);

    const service = new AdminAttendeesService(req);

    res.json({
      success: true,
      code: 'ATTENDEE_RESTORED',
      data: await service.setArchived(attendeeId, false),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Removes the display name an attendee chose for their pass.
 *
 * `DELETE`, which departs from the attendee's own `PATCH
 * /api/v1/attendee/nickname` where an empty string clears it. That endpoint
 * sets *and* clears, so it carries a value; an administrator may only ever
 * clear, and an endpoint carrying a value would be shaped to accept something
 * it then refuses.
 */
export const clearNickname: RequestHandler = async (req, res, next) => {
  try {
    const attendeeId = readAttendeeId(req);

    const service = new AdminAttendeesService(req);

    res.json({
      success: true,
      code: 'ATTENDEE_NICKNAME_CLEARED',
      data: await service.clearNickname(attendeeId),
    });
  } catch (err) {
    next(err);
  }
};
