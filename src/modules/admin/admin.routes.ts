import express from 'express';

import * as controller from './admin.controller.ts';
import attendeesRoutes from './admin.attendees.routes.ts';
import lookupRoutes from './admin.lookup.routes.ts';
import redemptionsRoutes from './admin.redemptions.routes.ts';
import ticketLimitRoutes from './admin.ticket-limit.routes.ts';
import tshirtsRoutes from './admin.tshirts.routes.ts';
import volunteersRoutes from './admin.volunteers.routes.ts';
import whatsappRoutes from './admin.whatsapp.routes.ts';
import whatsappDoorRoutes from './admin.whatsapp-door.routes.ts';
import surveyAdminRoutes from '../survey/survey.admin.routes.ts';
import passAdminRoutes from '../pass/pass.admin.routes.ts';

import { requireAdminScope } from '../../middleware/permission.middleware.ts';

/**
 * Admin routes that require a session.
 *
 * Mounted in api/index.ts behind `requireSessionType('admin')`, so everything
 * here has one. Individual routes add `requireAdminScope` for what they touch;
 * neither of the two below does, because knowing who you are and signing out
 * are not privileges an administrator can be short of.
 *
 * The attendees editor is gated at its mount instead of per route, because
 * every route it carries is a write. That is the first call site
 * `requireAdminScope` has ever had — the access gate shipped it unused, and the
 * admin shell said the first would arrive with the first screen.
 *
 * The quick lookup is mounted the same way and for the same reason, on a
 * different scope. `checkin:write` is what lets a support volunteer stand in
 * for the QR scan and the verification code; `attendees:read` is what opens the
 * screen, and it is enforced on the rendered pages rather than here.
 *
 * The WhatsApp sender's writes are gated the same way on `whatsapp:send`. Its
 * progress poll is deliberately not mounted here — see `api/index.ts`.
 *
 * The door message's switch is gated on `whatsapp:send` too, on its own mount:
 * it is the same privilege — deciding that the event spends money on messages —
 * and a separate router keeps it out of the sender's.
 *
 * The ticket limit's setting is gated on `attendees:limit`, on its own mount:
 * it is a separate privilege from writing attendees, and the editor that obeys
 * the limit needs only `attendees:write`.
 *
 * The questionnaire's override is gated on `survey:write`. Its page and its
 * downloads read under `export:read`, enforced on the rendered routes.
 *
 * The pass's welcome schedule is gated on `pass:write`, as is its page.
 *
 * Redemption corrections are gated on `redemptions:write`. The screen and its
 * totals poll read under `redemptions:read` — the poll in `api/index.ts`, for
 * its own limiter, the screen on the rendered routes.
 *
 * The T-shirt desk's hand-over is gated on `tshirt:redeem`, which also opens
 * its screen on the rendered routes. It stands apart from `redemptions:write`:
 * that scope corrects the record, this one only hands out a shirt.
 *
 * Volunteer permission changes are gated on `volunteers:write`, as is their
 * screen on the rendered routes. The gate is not the only check: the database
 * function behind the write re-checks the scope itself (see `032`).
 */
const router = express.Router();

router.get('/me', controller.me);

router.post('/logout', controller.logout);

router.use('/attendees', requireAdminScope('attendees:write'), attendeesRoutes);

router.use('/lookup', requireAdminScope('checkin:write'), lookupRoutes);

router.use('/whatsapp', requireAdminScope('whatsapp:send'), whatsappRoutes);

router.use(
  '/whatsapp-door',
  requireAdminScope('whatsapp:send'),
  whatsappDoorRoutes,
);

router.use(
  '/ticket-limit',
  requireAdminScope('attendees:limit'),
  ticketLimitRoutes,
);

router.use('/survey', requireAdminScope('survey:write'), surveyAdminRoutes);

router.use('/pass', requireAdminScope('pass:write'), passAdminRoutes);

router.use(
  '/redemptions',
  requireAdminScope('redemptions:write'),
  redemptionsRoutes,
);

router.use('/tshirts', requireAdminScope('tshirt:redeem'), tshirtsRoutes);

router.use(
  '/volunteers',
  requireAdminScope('volunteers:write'),
  volunteersRoutes,
);

export default router;
