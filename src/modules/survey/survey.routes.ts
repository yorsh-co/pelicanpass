import express from 'express';

import * as controller from './survey.controller.ts';

const router = express.Router();

router.post('/', controller.submit);

export default router;
