import type { RequestHandler, Request } from 'express';

import { AdminTshirtsService } from './admin.tshirts.service.ts';

import { ValidationError } from '../../shared/errors/app-error.ts';
import { isUuid } from '../../shared/utils/uuid.ts';

/**
 * The T-shirt desk's one write endpoint.
 *
 * Searching and reading a record are not here: both pages are server-rendered
 * from a submitted form, as with the quick lookup.
 */

/**
 * Reads and checks the attendee this request names.
 *
 * A `ValidationError` rather than a `NotFoundError`, so "this is not an ID" and
 * "no attendee has this ID" stay separable in a log line — and because without
 * the guard a malformed segment reaches Postgres as `22P02` and is reported as
 * a 500, which blames the server for a bad request.
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
 * Hands an attendee their T-shirt.
 *
 * Carries no body: the attendee is named by the path, and the item is pinned to
 * `tshirt` by the service. Safe to call twice — a repeat answers `duplicate`
 * with the original time rather than an error.
 */
export const redeem: RequestHandler = async (req, res, next) => {
  try {
    const attendeeId = readAttendeeId(req);

    const service = new AdminTshirtsService(req);

    res.json({
      success: true,
      code: 'TSHIRT_REDEEMED',
      data: await service.redeem(attendeeId),
    });
  } catch (err) {
    next(err);
  }
};
