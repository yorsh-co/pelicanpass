import express from 'express';

import * as controller from './staff.controller.ts';

import { env } from '../../config/env.ts';

const router = express.Router();

// Registered only where the band is enabled. With it off the volunteer's screen
// shows a clock and polls nothing, so the endpoint has no caller — and an
// endpoint that answers for a control nobody is running is one more way to
// think the control is running.
if (env.passBandEnabled) router.get('/band', controller.band);

router.post('/verify', controller.verify);
router.post('/redeem', controller.redeem);

router.post('/lookup', controller.lookup);

export default router;
