import express from 'express';

import * as controller from './admin.whatsapp-door.controller.ts';

const router = express.Router();

router.post('/switch', controller.setSwitch);

export default router;
