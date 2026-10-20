import express from 'express';

import * as controller from './checkin.controller.ts';

import {
  checkinEntryPacingLimiter,
  checkinSessionLimiter,
} from '../../middleware/rate.middleware.ts';
import { requireCaptchaIfFlagged } from '../../middleware/captcha.middleware.ts';
import {
  requireSessionType,
  resolveSessions,
} from '../../middleware/auth.middleware.ts';

const router = express.Router();

// These two steps *issue* the check-in session, so they run above
// resolveSessions and there is no resolved ID for a limiter to key on. They
// take the cookie-keyed pacing limiter instead — see its JSDoc for why that is
// pacing rather than a control, and what is.
//
// The ticket step is the only one that renders a captcha, so it is the only
// one that can be challenged on the global failure budget. The others answer
// CAPTCHA_REQUIRED by navigating back here.
router.post(
  '/ticket',
  checkinEntryPacingLimiter,
  requireCaptchaIfFlagged({ includeGlobalFailureBudget: true }),
  controller.submitTicket,
);
router.post(
  '/qr',
  checkinEntryPacingLimiter,
  requireCaptchaIfFlagged(),
  controller.submitQrCode,
);

router.use(resolveSessions);
router.use(requireSessionType('checkin'));

// Below the two above, so it only ever sees a session the store resolved. A
// forged cookie is a 401 from requireSessionType and never reaches here, which
// is also why it creates no Redis key.
router.use(checkinSessionLimiter);

router.post(
  '/verification',
  requireCaptchaIfFlagged(),
  controller.submitVerification,
);
router.post('/presence', requireCaptchaIfFlagged(), controller.checkPresence);
router.post('/reset', requireCaptchaIfFlagged(), controller.reset);

export default router;
