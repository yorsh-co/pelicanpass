import express from 'express';

import * as controller from './admin.attendees.controller.ts';

import { idempotent } from '../../middleware/idempotency.middleware.ts';

/**
 * The attendees editor's write endpoints.
 *
 * Mounted from `admin.routes.ts` behind `requireAdminScope('attendees:write')`,
 * applied once at the mount rather than repeated on each route because every
 * route here is a write. **A read route must not be added below that gate**:
 * opening the roster is `attendees:read`, and a volunteer holding only that
 * scope is meant to see it.
 *
 * There is no read endpoint at all. The list is server-rendered from the query
 * string, so nothing crosses this API but a change — which is what keeps a
 * screen an operator types into inside `adminSessionLimiter`'s 20 requests per
 * 60 seconds. Creating walk-ins one after another at a door is the burst that
 * would reach that cap; widening it is a decision about a security control, not
 * a detail of this screen.
 */
const router = express.Router();

// Re-sent after a timeout, a create would add a second attendee with a new
// code. The other writes set a fixed state and are safe to repeat as they are.
router.post('/', idempotent('attendee-create'), controller.create);

router.patch('/:attendeeId', controller.update);

router.post('/:attendeeId/archive', controller.archive);

router.post('/:attendeeId/restore', controller.restore);

router.delete('/:attendeeId/nickname', controller.clearNickname);

export default router;
