import type { RequestHandler } from 'express';

import { env } from '../../config/env.ts';
import { PassAdminService } from './pass.admin.ts';
import { readWelcomeScheduleSave } from './pass.admin.rules.ts';

/** Saves the welcome schedule, or hands it back to `.env`. */
export const saveWelcomeSchedule: RequestHandler = async (req, res, next) => {
  try {
    const save = readWelcomeScheduleSave(req.body, env.landing.timezone);

    const service = new PassAdminService(req);

    res.json({
      success: true,
      code: 'PASS_WELCOME_SCHEDULE_SAVED',
      data: { revision: await service.save(save) },
    });
  } catch (err) {
    next(err);
  }
};
