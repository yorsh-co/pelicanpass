import type { RequestHandler } from 'express';

import { CheckinService } from './checkin.service.ts';

import { readStringField } from '../../shared/utils/request-body.ts';

/*
 * Every step here flattens an absent field to `''`, which is what its validator
 * already rejects for an empty one — so a body that failed to parse arrives at
 * the same 400 as a mistyped ticket code. Endpoints where an empty value means
 * something of its own must keep the two apart; see `readStringField`.
 */

/** Submits a ticket code, the first step of a check-in. */
export const submitTicket: RequestHandler = async (req, res, next) => {
  try {
    const service = new CheckinService({ req, res });

    const result = await service.submitTicket(
      readStringField(req.body, 'ticket') ?? '',
    );

    res.json({
      success: true,
      code: 'TICKET_VALIDATED',
      meta: result.meta,
      data: result.data ?? {},
    });
  } catch (err) {
    next(err);
  }
};

/** Submits the phone verification code for a ticket already accepted. */
export const submitVerification: RequestHandler = async (req, res, next) => {
  try {
    const service = new CheckinService({ req, res });

    const result = await service.submitVerification(
      readStringField(req.body, 'verificationCode') ?? '',
    );

    res.json({
      success: true,
      code: 'ATTENDEE_VERIFIED',
      meta: result.meta,
      data: result.data ?? {},
    });
  } catch (err) {
    next(err);
  }
};

/** Submits a scanned QR payload, completing the check-in. */
export const submitQrCode: RequestHandler = async (req, res, next) => {
  try {
    const service = new CheckinService({ req, res });

    const result = await service.submitQrCode(
      readStringField(req.body, 'qrCode') ?? '',
    );

    res.json({
      success: true,
      code: 'QR_PROCESSED',
      meta: result.meta,
      data: result.data ?? {},
    });
  } catch (err) {
    next(err);
  }
};

/** Continues a verified attendee whom staff have marked present. */
export const checkPresence: RequestHandler = async (req, res, next) => {
  try {
    const service = new CheckinService({ req, res });

    const result = await service.checkPresence();

    res.json({
      success: true,
      code: 'PRESENCE_CONFIRMED',
      meta: result.meta,
      data: result.data ?? {},
    });
  } catch (err) {
    next(err);
  }
};

/** Discards the current check-in session and starts the flow over. */
export const reset: RequestHandler = async (req, res, next) => {
  try {
    const service = new CheckinService({ req, res });

    const result = await service.resetCheckin();

    res.json({
      success: true,
      code: 'CHECKIN_RESET',
      meta: result.meta,
      data: result.data ?? {},
    });
  } catch (err) {
    next(err);
  }
};
