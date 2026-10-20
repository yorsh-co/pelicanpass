import express from 'express';

import * as controller from './admin.whatsapp.controller.ts';

/**
 * The WhatsApp sender's write endpoints.
 *
 * Mounted from `admin.routes.ts` behind `requireAdminScope('whatsapp:send')`,
 * applied once at the mount because every route here is a write — the same
 * arrangement as the attendees editor. They sit under `adminSessionLimiter`'s
 * 20 requests a minute, which is the right budget for buttons an operator
 * presses and for a test send that reaches Meta.
 *
 * **The progress poll is not here.** It is registered on its own in
 * `api/index.ts`, above `/admin`, so that a three-second poll charges
 * `whatsappPollLimiter` instead of spending this budget. Adding it below would
 * put it back under the admin limit and starve the stop button beside it.
 */
const router = express.Router();

router.post('/preview', controller.preview);

router.post('/runs', controller.startRun);

router.post('/runs/:runId/stop', controller.stopRun);

router.post('/runs/:runId/resume', controller.resumeRun);

router.post('/runs/:runId/retry-interrupted', controller.retryInterrupted);

router.post('/runs/:runId/cancel', controller.cancelRun);

router.post('/test', controller.testSend);

export default router;
