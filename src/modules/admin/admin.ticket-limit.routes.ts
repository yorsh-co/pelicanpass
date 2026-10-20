import express from 'express';

import * as controller from './admin.ticket-limit.controller.ts';

const router = express.Router();

router.post('/', controller.set);

export default router;
