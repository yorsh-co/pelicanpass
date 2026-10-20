import express from 'express';

import * as controller from './raffle.controller.ts';

import { idempotent } from '../../middleware/idempotency.middleware.ts';

const router = express.Router();

router.get('/draws', controller.draws);

// Re-sent after a timeout, a draw would call a second number and, with repeats
// off, take it out of the pool. A reset is safe to repeat as it is.
router.post('/draw', idempotent('raffle-draw'), controller.draw);

router.post('/reset', controller.reset);

export default router;
