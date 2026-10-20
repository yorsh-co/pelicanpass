import type { RequestHandler } from 'express';

import { hasAdminScope } from '../../middleware/permission.middleware.ts';
import { buildSnapshot } from './metrics.service.ts';

/**
 * One dashboard poll.
 *
 * `no-store` for the same reason the raffle's draws endpoint sets it: the whole
 * value of this response is that it is current, and a cached copy would show an
 * operator a door that stopped moving five minutes ago.
 *
 * The questionnaire's totals ride along only for an administrator who also holds
 * `export:read`, the scope that gates the same counts on `/admin/survey`.
 */
export const snapshot: RequestHandler = async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const survey = await hasAdminScope(req, 'export:read');

    res.json({ success: true, data: await buildSnapshot({ survey }) });
  } catch (err) {
    next(err);
  }
};
