import express from 'express';

import * as controller from './admin.controller.ts';

/**
 * The one admin route reachable without an admin session.
 *
 * Kept in its own router, mounted above the gated one in api/index.ts, because
 * `requireSessionType('admin')` cannot cover the endpoint that issues the
 * session. Sign-out lives in admin.routes.ts instead: ending a session requires
 * holding one.
 */
const router = express.Router();

router.post('/login', controller.login);

export default router;
