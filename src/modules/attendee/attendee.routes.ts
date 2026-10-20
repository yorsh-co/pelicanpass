import express from 'express';

import * as controller from './attendee.controller.ts';

const router = express.Router();

router.post('/logout', controller.logout);

router.get('/pass', controller.pass);

router.get('/status', controller.status);

router.patch('/nickname', controller.updateNickname);

export default router;
