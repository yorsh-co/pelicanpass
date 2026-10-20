import express from 'express';

import * as controller from './admin.lookup.controller.ts';

/**
 * The volunteer quick lookup's write endpoint, also used by the attendee
 * editor.
 *
 * Mounted from `admin.routes.ts` behind `requireAdminScope('checkin:write')`,
 * applied once at the mount rather than on the route, because the only thing
 * this router will ever carry is the privileged action. **A read route must not
 * be added below that gate**: opening the lookup is `attendees:read`, and a
 * volunteer holding only that scope is meant to reach it and find no button.
 *
 * There is no read endpoint at all — both pages are server-rendered.
 */
const router = express.Router();

router.post('/:attendeeId/checkin', controller.markPresent);

export default router;
