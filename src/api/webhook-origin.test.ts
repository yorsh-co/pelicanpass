import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const APP_SECRET = 'test-app-secret';
const PATH_SECRET = 'test-path-secret-0123456789abcdef';
const WEBHOOK_PATH = `/api/v1/whatsapp/webhook/${PATH_SECRET}`;

// `api/index.ts` decides whether to mount the webhook when it loads, so the
// switch has to be set before the dynamic imports below.
process.env.WHATSAPP_WEBHOOK_ENABLED = 'true';
process.env.WHATSAPP_APP_SECRET = APP_SECRET;
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'test-verify-token';
process.env.WHATSAPP_WEBHOOK_PATH_SECRET = PATH_SECRET;

const { default: apiRoutes } = await import('./index.ts');
const { default: redis } = await import('../shared/db/redis.ts');

const warnings: string[] = [];

/** A request logger that remembers warnings, in place of pino-http. */
const requestLog = Object.fromEntries(
  ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((level) => [
    level,
    (...args: unknown[]) => {
      const message = args.find((a) => typeof a === 'string');

      if (level === 'warn' && message !== undefined) {
        warnings.push(message);
      }
    },
  ]),
);

let server: Server;
let base: string;

before(async () => {
  const app = express();

  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = requestLog;
    next();
  });
  app.use('/api/v1', apiRoutes);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  redis.disconnect();
});

/** A receipt batch with no status events, so no database is reached. */
const payload = JSON.stringify({ object: 'whatsapp_business_account' });

const sign = (raw: string): string =>
  `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;

/** Posts JSON without an `Origin`, the way a server-to-server caller does. */
const postWithoutOrigin = (
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: payload,
  });

describe('webhook and the same-origin check', () => {
  it('accepts a validly signed delivery that carries no Origin', async () => {
    const res = await postWithoutOrigin(WEBHOOK_PATH, {
      'X-Hub-Signature-256': sign(payload),
    });

    assert.equal(res.status, 200);
  });

  it('still refuses an unsigned delivery, by its signature', async () => {
    warnings.length = 0;

    const res = await postWithoutOrigin(WEBHOOK_PATH);

    assert.equal(res.status, 403);
    assert.deepEqual(warnings, ['WhatsApp webhook signature refused']);
  });

  it('still refuses a wrongly signed delivery', async () => {
    warnings.length = 0;

    const res = await postWithoutOrigin(WEBHOOK_PATH, {
      'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`,
    });

    assert.equal(res.status, 403);
    assert.deepEqual(warnings, ['WhatsApp webhook signature refused']);
  });

  it('still refuses any other API POST with no Origin', async () => {
    for (const path of ['/api/v1/client-errors', '/api/v1/checkin/ticket']) {
      const res = await postWithoutOrigin(path);
      const body = (await res.json()) as { code: string };

      assert.equal(res.status, 403, path);
      assert.equal(body.code, 'FORBIDDEN', path);
    }
  });
});
