import type { RequestHandler } from 'express';

import { AttendeeService } from './attendee.service.ts';

import { ValidationError } from '../../shared/errors/app-error.ts';
import { readStringField } from '../../shared/utils/request-body.ts';

/** Ends the attendee's session and clears its cookie. */
export const logout: RequestHandler = async (req, res, next) => {
  try {
    const service = new AttendeeService({ req, res });

    await service.logoutAttendee();

    res.status(204).end();
  } catch (err) {
    next(err);
  }
};

/**
 * Serves the rotating half of the pass: band, token, QR and remaining window.
 *
 * `no-store` is set by hand because the global one at `app.ts` is
 * development-only, and `res.json` carries a weak `ETag` by default. Without it
 * a per-attendee credential would travel through a CDN with no cache
 * directives at all.
 */
export const pass: RequestHandler = async (req, res, next) => {
  try {
    const service = new AttendeeService({ req, res });

    const issued = await service.issuePass();

    res.setHeader('Cache-Control', 'no-store');

    res.json({
      success: true,
      code: 'PASS_ISSUED',
      data: issued,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Serves the front of the pass: the redemption slots and the questionnaire's
 * state, with no credential.
 *
 * `no-store` for the same reason as {@link pass}: the payload is per-attendee.
 */
export const status: RequestHandler = async (req, res, next) => {
  try {
    const service = new AttendeeService({ req, res });

    const current = await service.readStatus();

    res.setHeader('Cache-Control', 'no-store');

    res.json({
      success: true,
      code: 'PASS_STATUS',
      data: current,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Sets or clears the display name on the attendee's pass.
 *
 * An empty `nickname` clears it; a **missing** one is rejected. The two cannot
 * be treated alike here: `requireSupportedContentType` lets a request with no
 * `Content-Type` through, `express.json` then leaves `req.body` undefined, and
 * flattening that to `''` would turn a malformed request into an instruction to
 * erase a stored value.
 */
export const updateNickname: RequestHandler = async (req, res, next) => {
  try {
    const nickname = readStringField(req.body, 'nickname');

    if (nickname === undefined) throw new ValidationError('Invalid nickname');

    const service = new AttendeeService({ req, res });

    const stored = await service.setNickname(nickname);

    res.json({
      success: true,
      code: 'NICKNAME_UPDATED',
      data: { nickname: stored },
    });
  } catch (err) {
    next(err);
  }
};
