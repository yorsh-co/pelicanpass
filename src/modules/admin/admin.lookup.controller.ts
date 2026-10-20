import type { RequestHandler, Request } from 'express';

import { AdminLookupService } from './admin.lookup.service.ts';

import { ValidationError } from '../../shared/errors/app-error.ts';
import { isUuid } from '../../shared/utils/uuid.ts';

/**
 * The volunteer quick lookup's one write endpoint, also used by the attendee
 * editor.
 *
 * Searching and reading a record are not here. Both pages are server-rendered
 * from a submitted form, which is what keeps a volunteer looking people up all
 * evening inside `adminSessionLimiter`'s 20 requests per 60 seconds — only
 * marking somebody present spends from that budget.
 *
 * Messages are pt-BR, matching the service.
 */

/**
 * Reads and checks the attendee this request names.
 *
 * A `ValidationError` rather than a `NotFoundError`, so "this is not an ID" and
 * "no attendee has this ID" stay separable in a log line — and because without
 * the guard a malformed segment reaches Postgres as `22P02` and is reported as
 * a 500, which blames the server for a bad request. The same predicate answers
 * differently on the rendered page, which redirects to the search instead.
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
 * Marks an attendee present, standing in for the QR scan they cannot complete.
 *
 * Carries no body: the attendee is named by the path and there is nothing else
 * to decide. Safe to call twice — the response says which of the two happened.
 */
export const markPresent: RequestHandler = async (req, res, next) => {
  try {
    const attendeeId = readAttendeeId(req);

    const service = new AdminLookupService(req);

    res.json({
      success: true,
      code: 'ATTENDEE_CHECKED_IN',
      data: await service.markPresent(attendeeId),
    });
  } catch (err) {
    next(err);
  }
};
