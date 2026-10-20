import type { Request, RequestHandler } from 'express';

import {
  AdminRedemptionsService,
  buildRedemptionSummary,
} from './admin.redemptions.service.ts';
import { parseCorrection } from './admin.redemptions.rules.ts';

import { isRedemptionItem } from '../../constants/pass.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';
import { isUuid } from '../../shared/utils/uuid.ts';

import type { RedemptionCorrection } from '../../constants/redemptions.ts';
import type { RedemptionItem } from '../../constants/pass.ts';

/**
 * The redemptions screen's endpoints: its poll, and the two corrections.
 *
 * Reading a list or a record is not here. Both are server-rendered from a
 * submitted form, as the roster and the lookup are.
 */

/**
 * Reads and checks the attendee and item this request names.
 *
 * A malformed segment is a `ValidationError` rather than a `NotFoundError`, for
 * the reason `admin.lookup.controller.ts` gives: without the guard a bad UUID
 * reaches Postgres as `22P02` and is reported as a 500.
 *
 * @param req - Request carrying the route parameters.
 * @throws {ValidationError} If either parameter is absent or malformed.
 */
const readTarget = (
  req: Request,
): { attendeeId: string; item: RedemptionItem } => {
  const { attendeeId, item } = req.params;

  if (!isUuid(attendeeId)) {
    throw new ValidationError('Invalid attendee ID', {
      reason: 'invalidAttendee',
    });
  }

  if (typeof item !== 'string' || !isRedemptionItem(item)) {
    throw new ValidationError('Invalid item');
  }

  return { attendeeId, item };
};

/**
 * One poll of the totals.
 *
 * Mounted in `api/index.ts` above `/admin`, behind its own limiter and
 * `redemptions:read`, so the screen's refresh never spends the budget its
 * corrections draw on.
 */
export const summary: RequestHandler = async (_req, res, next) => {
  try {
    res.json({
      success: true,
      code: 'REDEMPTION_SUMMARY',
      data: await buildRedemptionSummary(),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Builds the handler for one correction.
 *
 * @param correction - Which correction the route applies.
 */
const correct =
  (correction: RedemptionCorrection): RequestHandler =>
  async (req, res, next) => {
    try {
      const { attendeeId, item } = readTarget(req);
      const request = parseCorrection(correction, req.body);

      const result = await new AdminRedemptionsService(req).correct(
        attendeeId,
        item,
        correction,
        request,
      );

      res.json({ success: true, code: 'REDEMPTION_CORRECTED', data: result });
    } catch (err) {
      next(err);
    }
  };

/** Records by hand that an item was handed over. */
export const mark = correct('mark');

/** Undoes a recorded collection. */
export const revert = correct('revert');
