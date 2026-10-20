import express from 'express';

import * as controller from './admin.volunteers.controller.ts';

/**
 * The volunteer permissions screen's write.
 *
 * Mounted from `admin.routes.ts` behind `requireAdminScope('volunteers:write')`,
 * applied once at the mount. **A read route must not be added below that
 * gate**; the page itself is gated on the rendered routes.
 */
const router = express.Router();

router.post('/:attendeeId', controller.save);

export default router;
