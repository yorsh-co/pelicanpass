import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { env } from '../config/env.ts';
import apiRoutes from '../api/index.ts';
import redis from '../shared/db/redis.ts';
import { AppError, RateLimitError } from '../shared/errors/app-error.ts';
import { total } from '../shared/telemetry/window.ts';

import { normaliseBodyParserError } from './body-parser-error.middleware.ts';
import { httpCounters } from './telemetry.middleware.ts';

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

before(async () => {
  const app = express();

  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = requestLog;
    next();
  });
  app.use(httpCounters);
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

/** Posts a plain JSON body that claims a content encoding. */
const post = async (
  path: string,
  encoding: string,
  body = '{"x":1}',
): Promise<Response> =>
  fetch(`${base}/api/v1${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': encoding,
      Origin: new URL(env.appUrl).origin,
    },
    body,
  });

describe('body-parser client errors', () => {
  for (const [name, path] of [
    ['a JSON API route', '/checkin/ticket'],
    ['/client-errors', '/client-errors'],
  ] as const) {
    for (const encoding of ['gzip', 'br', 'bogus']) {
      it(`answers Content-Encoding: ${encoding} on ${name} with 415`, async () => {
        const before5xx = total('http.5xx', 1);

        levels.length = 0;

        const res = await post(path, encoding);

        assert.equal(res.status, 415);

        assert.deepEqual(await res.json(), {
          success: false,
          error: 'Unsupported content encoding',
          code: 'UNSUPPORTED_MEDIA_TYPE',
        });

        // `finish` fires after the body is read; let the counter settle.
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(total('http.5xx', 1), before5xx);
        assert.ok(!levels.includes('error'), `logged ${levels.join(',')}`);
      });
    }
  }

  it('still answers a malformed JSON body with 400', async () => {
    const res = await post('/checkin/ticket', 'identity', '{"x":');

    assert.equal(res.status, 400);
  });

  it('still answers an oversized body with 413', async () => {
    const res = await post('/client-errors', 'identity', 'x'.repeat(5000));

    assert.equal(res.status, 413);
  });
});

/** Runs the normaliser on an error and returns what it passed on. */
const normalise = (err: unknown): unknown => {
  let passed: unknown;

  normaliseBodyParserError(
    err,
    {} as express.Request,
    {} as express.Response,
    (next?: unknown) => {
      passed = next;
    },
  );

  return passed;
};

/** A body-parser failure: an `Error` carrying `status` and `type`. */
const parserError = (status: number, type: string): Error =>
  Object.assign(new Error(type), { status, statusCode: status, type });

describe('normaliseBodyParserError', () => {
  const cases: [string, number, string, number, string][] = [
    [
      'entity.parse.failed',
      400,
      'VALIDATION_ERROR',
      400,
      'entity.parse.failed',
    ],
    ['entity.too.large', 413, 'PAYLOAD_TOO_LARGE', 413, 'entity.too.large'],
    [
      'encoding.unsupported',
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      415,
      'encoding.unsupported',
    ],
    [
      'charset.unsupported',
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      415,
      'charset.unsupported',
    ],
    ['request.aborted', 400, 'VALIDATION_ERROR', 400, 'request.aborted'],
    [
      'request.size.invalid',
      400,
      'VALIDATION_ERROR',
      400,
      'request.size.invalid',
    ],
    ['entity.verify.failed', 403, 'FORBIDDEN', 403, 'entity.verify.failed'],
  ];

  for (const [type, status, code] of cases) {
    it(`maps ${type} to ${String(status)} ${code}`, () => {
      const passed = normalise(parserError(status, type)) as AppError;

      assert.ok(passed instanceof AppError);
      assert.equal(passed.statusCode, status);
      assert.equal(passed.code, code);
    });
  }

  it('maps a 4xx body-parser error with no known type to 400', () => {
    const passed = normalise(parserError(422, 'something.new')) as AppError;

    assert.equal(passed.statusCode, 400);
  });

  it('leaves a 5xx body-parser error and any other error alone', () => {
    const serverFault = parserError(500, 'stream.encoding.set');
    const other = new Error('boom');

    assert.equal(normalise(serverFault), serverFault);
    assert.equal(normalise(other), other);
  });

  it('leaves an AppError raised by an earlier router alone', () => {
    const limited = new RateLimitError('slow down', 3);

    assert.equal(normalise(limited), limited);
  });
});
