import express from 'express';

import * as controller from './metrics.controller.ts';

import { requireAdminScope } from '../../middleware/permission.middleware.ts';

/**
 * The live metrics panel's data.
 *
 * Mounted in `api/index.ts` **above** `/admin`, carrying its own
 * `requireSessionType('admin')` and `metricsPollLimiter` — see the comment
 * there for why the ordering is load-bearing rather than stylistic.
 *
 * `metrics:read` is the scope the admin shell reserved for this screen when the
 * nav entry was added; this is its first runtime reader.
 */
const router = express.Router();

router.get('/snapshot', requireAdminScope('metrics:read'), controller.snapshot);

export default router;
