import express from 'express';

import * as controller from './pass.admin.controller.ts';

const router = express.Router();

router.put('/welcome-schedule', controller.saveWelcomeSchedule);

export default router;
