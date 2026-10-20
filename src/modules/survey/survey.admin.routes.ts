import express from 'express';

import * as controller from './survey.admin.controller.ts';

const router = express.Router();

router.post('/override', controller.setOverride);

export default router;
