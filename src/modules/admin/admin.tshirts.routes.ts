import express from 'express';

import * as controller from './admin.tshirts.controller.ts';

/**
 * The T-shirt desk's write endpoint.
 *
 * Mounted from `admin.routes.ts` behind `requireAdminScope('tshirt:redeem')`,
 * applied once at the mount because the only thing this router carries is the
 * hand-over itself. The same scope opens the screen, enforced on the rendered
 * pages.
 *
 * There is no read endpoint at all — the search and the record page are
 * server-rendered, which keeps a desk working a queue inside the session
 * limiter's budget: only handing a shirt over spends from it.
 */
const router = express.Router();

router.post('/:attendeeId/redeem', controller.redeem);

export default router;
