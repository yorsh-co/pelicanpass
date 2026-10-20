import express from 'express';

import * as controller from './whatsapp.webhook.controller.ts';

import { normaliseBodyParserError } from '../../middleware/body-parser-error.middleware.ts';

import type { Request } from 'express';

/**
 * Meta's delivery-receipt callback.
 *
 * Mounted in `api/index.ts` **above** the global body parser, and that is the
 * whole reason this router carries a parser of its own. Meta signs the **raw
 * bytes**, and a parsed body cannot be re-serialised byte-identically — key
 * order and whitespace are gone — so the signature has to be checked against
 * what actually arrived. `express.json` below that mount would claim the body
 * first and leave nothing to verify, and it would fail as an authentication bug
 * rather than as a parse error.
 *
 * `normaliseBodyParserError` is repeated here for the reason
 * `client-error.routes.ts` gives: the router's copy sits below this mount, so
 * without it an oversized body leaves in body-parser's shape rather than the
 * API's.
 *
 * 64 kB rather than the global 10 kB. Meta batches status events, and a batch
 * of a few hundred is ordinary on a seven-hundred-recipient run.
 */
const router = express.Router();

/**
 * Keeps the exact bytes for {@link verifyWebhookSignature}.
 *
 * The first raw-body capture in this repository.
 */
const captureRawBody = (
  req: Request,
  _res: express.Response,
  buf: Buffer,
): void => {
  req.rawBody = buf;
};

router.get('/', controller.handshake);

router.post(
  '/',
  express.json({ limit: '64kb', verify: captureRawBody }),
  normaliseBodyParserError,
  controller.receive,
);

export default router;
