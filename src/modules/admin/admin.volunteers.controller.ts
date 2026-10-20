import { AdminVolunteersService } from './admin.volunteers.service.ts';
import { readVolunteerPermissions } from './admin.volunteers.rules.ts';

import { ValidationError } from '../../shared/errors/app-error.ts';
import { isUuid } from '../../shared/utils/uuid.ts';

import type { RequestHandler } from 'express';

/**
 * The volunteer permissions endpoint.
 *
 * Reading the list or a record is not here: both are server-rendered, as the
 * roster and the redemptions screen are.
 */

/**
 * Saves one volunteer's permissions.
 *
 * A malformed `:attendeeId` is a `ValidationError` rather than a
 * `NotFoundError`, for the reason `admin.redemptions.controller.ts` gives.
 */
export const save: RequestHandler = async (req, res, next) => {
  try {
    const { attendeeId } = req.params;

    if (!isUuid(attendeeId)) {
      throw new ValidationError('Invalid attendee ID', {
        reason: 'invalidAttendee',
      });
    }

    const values = readVolunteerPermissions(req.body);

    const result = await new AdminVolunteersService(req).save(
      attendeeId,
      values,
    );

    res.json({
      success: true,
      code: 'VOLUNTEER_PERMISSIONS_SAVED',
      data: result,
    });
  } catch (err) {
    next(err);
  }
};
