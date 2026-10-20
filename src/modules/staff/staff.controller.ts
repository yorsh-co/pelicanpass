import type { RequestHandler } from 'express';

import { StaffService } from './staff.service.ts';

import { isRedemptionItem } from '../../constants/pass.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';
import { readStringField } from '../../shared/utils/request-body.ts';

/** The band the volunteer compares against the pass in front of them. */
export const band: RequestHandler = (req, res, next) => {
  try {
    const service = new StaffService({ req, res });

    res.setHeader('Cache-Control', 'no-store');

    res.json({ success: true, code: 'BAND_ISSUED', data: service.getBand() });
  } catch (err) {
    next(err);
  }
};

/** Verifies a scanned pass and opens a review. */
export const verify: RequestHandler = async (req, res, next) => {
  try {
    const token = readStringField(req.body, 'token');

    if (!token) throw new ValidationError('Invalid pass');

    const service = new StaffService({ req, res });

    res.json({
      success: true,
      code: 'PASS_VERIFIED',
      data: await service.verify(token),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Records that an item was handed over.
 *
 * Answers 200 for all three outcomes. `duplicate` and `not_entitled` are what
 * the volunteer asked about, not failures of their request — a 4xx would land
 * them in the client's error path and read as a fault in the app rather than an
 * answer about the attendee.
 */
export const redeem: RequestHandler = async (req, res, next) => {
  try {
    const handle = readStringField(req.body, 'handle');
    const item = readStringField(req.body, 'item');

    if (!handle) throw new ValidationError('Invalid review');
    if (!item || !isRedemptionItem(item)) {
      throw new ValidationError('Invalid item');
    }

    const service = new StaffService({ req, res });

    res.json({
      success: true,
      code: 'REDEMPTION_RECORDED',
      data: await service.redeem(handle, item),
    });
  } catch (err) {
    next(err);
  }
};

/** Opens a review from a typed identifier, when the camera will not serve. */
export const lookup: RequestHandler = async (req, res, next) => {
  try {
    const query = readStringField(req.body, 'query');

    if (!query) throw new ValidationError('Invalid lookup');

    const service = new StaffService({ req, res });

    res.json({
      success: true,
      code: 'ATTENDEE_FOUND',
      data: await service.lookup(query),
    });
  } catch (err) {
    next(err);
  }
};
