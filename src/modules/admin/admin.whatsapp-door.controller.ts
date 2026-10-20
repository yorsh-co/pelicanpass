import type { RequestHandler } from 'express';

import { AdminWhatsappDoorService } from './admin.whatsapp-door.service.ts';

import { ValidationError } from '../../shared/errors/app-error.ts';
import { readBooleanField } from '../../shared/utils/request-body.ts';

/**
 * Turns the door message switch on or off.
 *
 * `enabled` must be sent: a body that failed to parse leaves it absent, and
 * reading that as either position would turn a malformed request into an
 * instruction.
 */
export const setSwitch: RequestHandler = async (req, res, next) => {
  try {
    const enabled = readBooleanField(req.body, 'enabled');

    if (enabled === undefined) throw new ValidationError('Invalid switch');

    const service = new AdminWhatsappDoorService(req);

    res.json({
      success: true,
      code: 'WHATSAPP_DOOR_SWITCH_SET',
      data: await service.setSwitch(enabled),
    });
  } catch (err) {
    next(err);
  }
};
