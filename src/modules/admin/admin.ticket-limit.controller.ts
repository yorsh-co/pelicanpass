import type { RequestHandler } from 'express';

import { AdminTicketLimitService } from './admin.ticket-limit.service.ts';

/**
 * Replaces the ticket limit's setting.
 *
 * The body is passed through untrusted: the service validates every field, so
 * a body that failed to parse is refused rather than read as an instruction.
 */
export const set: RequestHandler = async (req, res, next) => {
  try {
    const service = new AdminTicketLimitService(req);

    res.json({
      success: true,
      code: 'TICKET_LIMIT_SET',
      data: await service.set(req.body),
    });
  } catch (err) {
    next(err);
  }
};
