import express from 'express';

import * as controller from './admin.redemptions.controller.ts';

/**
 * The redemptions screen's writes.
 *
 * Mounted from `admin.routes.ts` behind `requireAdminScope('redemptions:write')`,
 * applied once at the mount, because everything this router carries is a
 * correction. **A read route must not be added below that gate**: the screen
 * and its poll are `redemptions:read`, and an operator holding only that scope
 * is meant to reach them and find no buttons. The poll is registered in
 * `api/index.ts` for that reason, and for its own limiter.
 */
const router = express.Router();

router.post('/:attendeeId/:item/mark', controller.mark);

router.post('/:attendeeId/:item/revert', controller.revert);

export default router;
