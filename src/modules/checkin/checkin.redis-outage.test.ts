import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import cookieParser from 'cookie-parser';
import express from 'express';

import checkinRoutes from './checkin.routes.ts';
import { COOKIE_NAMES } from '../../constants/cookie-names.ts';
import { redisOutageToUnavailable } from '../../middleware/redis-outage.middleware.ts';
import { errorHandler } from '../../middleware/error.middleware.ts';
import { httpCounters } from '../../middleware/telemetry.middleware.ts';
import redis from '../../shared/db/redis.ts';
import { total } from '../../shared/telemetry/window.ts';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const levels: LogLevel[] = [];

/** A request logger that remembers the levels written, in place of pino-http. */
const requestLog = Object.fromEntries(
  ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((level) => [
    level,
    () => levels.push(level as LogLevel),
  ]),
);

let server: Server;
let base: string;

/**
 * Mounts the check-in router and the API's error handler without the gates
 * above it, whose answers depend on the clock. The shared client is never
 * connected here, so with `enableOfflineQueue` off
 * every command rejects with "Stream isn't writeable" — the error a stopped
 * `cache` container produces.
 */
before(async () => {
  const app = express();

  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = requestLog;
    next();
  });
  app.use(httpCounters);
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/v1/checkin', checkinRoutes);
  app.use(redisOutageToUnavailable);
  app.use(errorHandler);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  redis.disconnect();
});

/** Posts one check-in step as a browser would. */
const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${base}/api/v1/checkin${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('check-in with Redis unavailable', () => {
  for (const [step, body] of [
    ['/ticket', { ticketCode: 'xabc12' }],
    ['/qr', { qrToken: 'a'.repeat(20) }],
  ] as const) {
    it(`answers ${step} 503 with Retry-After, in the API's error shape`, async () => {
      levels.length = 0;

      const res = await post(step, body);

      assert.equal(res.status, 503);
      assert.match(res.headers.get('retry-after') ?? '', /^[1-9]\d*$/);

      assert.deepEqual(await res.json(), {
        success: false,
        error: 'Service temporarily unavailable',
        code: 'SERVICE_UNAVAILABLE',
        details: {
          retryAfterSeconds: Number(res.headers.get('retry-after')),
        },
      });
    });
  }

  // Below resolveSessions, which only queries Redis for a request that carries
  // a session cookie; without one the answer is a 401 and Redis is never asked.
  it('answers /presence 503 with Retry-After, in the API error shape', async () => {
    const res = await post(
      '/presence',
      {},
      { Cookie: `${COOKIE_NAMES.checkin}=outage-test` },
    );

    assert.equal(res.status, 503);
    assert.match(res.headers.get('retry-after') ?? '', /^[1-9]\d*$/);

    assert.deepEqual(await res.json(), {
      success: false,
      error: 'Service temporarily unavailable',
      code: 'SERVICE_UNAVAILABLE',
      details: {
        retryAfterSeconds: Number(res.headers.get('retry-after')),
      },
    });
  });

  it('logs at warn, never error', async () => {
    levels.length = 0;

    await post('/ticket', { ticketCode: 'xabc12' });

    assert.ok(levels.includes('warn'), `logged ${levels.join(',')}`);
    assert.ok(!levels.includes('error'), `logged ${levels.join(',')}`);
  });

  it('still counts as a 5xx, since it is a failure and not a shed', async () => {
    const before5xx = total('http.5xx', 1);
    const beforeShed = total('http.shed', 1);

    await post('/ticket', { ticketCode: 'xabc12' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(total('http.5xx', 1), before5xx + 1);
    assert.equal(total('http.shed', 1), beforeShed);
  });
});
