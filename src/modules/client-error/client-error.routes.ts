import express from 'express';

import * as controller from './client-error.controller.ts';

import { normaliseBodyParserError } from '../../middleware/body-parser-error.middleware.ts';

/**
 * The one public write endpoint in the application.
 *
 * Mounted in `api/index.ts` **above** the global body parser, which is what
 * lets the tighter limit below actually apply — body-parser skips a request
 * whose `req.body` is already set, so a 4 KB limit declared under the global
 * 10 KB one would be silently inert.
 *
 * `normaliseBodyParserError` is repeated here for the same reason: the router's
 * copy sits below this mount, so without it a 413 leaves in body-parser's shape
 * rather than the API's.
 */
const router = express.Router();

router.post(
  '/',
  express.json({ limit: '4kb', inflate: false }),
  normaliseBodyParserError,
  controller.report,
);

export default router;
