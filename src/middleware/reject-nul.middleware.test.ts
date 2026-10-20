import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// The closing gate answers every page before its routes once the event is
// over, which would hide the form chain under test.
process.env.EVENT_CLOSES_AT = '2099-12-31T23:59:00-03:00';

const { env } = await import('../config/env.ts');
const { default: app } = await import('../app.ts');
const { default: redis } = await import('../shared/db/redis.ts');
const { rejectNulInput } = await import('./reject-nul.middleware.ts');
const { ValidationError } = await import('../shared/errors/app-error.ts');

const ORIGIN = new URL(env.appUrl).origin;

let server: Server;
let base: string;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  redis.disconnect();
});

/** Posts to the API as a page of ours would, with the `Origin` it requires. */
const postJson = (path: string, body: string): Promise<Response> =>
  fetch(`${base}/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body,
  });

/** A survey submission whose `answers` is the given JSON text. */
const survey = (answers: string): string =>
  `{"structureVersion":"x","answers":${answers}}`;

/** Asserts the API's validation shape, which is what a 500 would replace. */
const assertRejected = async (res: Response): Promise<void> => {
  assert.equal(res.status, 400);

  const body = (await res.json()) as { code: string; success: boolean };

  assert.equal(body.success, false);
  assert.equal(body.code, 'VALIDATION_ERROR');
};

describe('NUL in a JSON body', () => {
  it('refuses a survey answer', async () => {
    await assertRejected(
      await postJson('/survey', survey('{"comments":"a\\u0000b"}')),
    );
  });

  it('refuses a nested value', async () => {
    await assertRejected(
      await postJson('/survey', survey('{"a":{"b":["ok",{"c":"x\\u0000"}]}}')),
    );
  });

  it('refuses a key', async () => {
    await assertRejected(
      await postJson('/survey', survey('{"foi\\u0000_inspirado":"ok"}')),
    );
  });

  it('does not refuse a body without one', async () => {
    const res = await postJson('/survey', survey('{"comments":"ok"}'));

    assert.notEqual(res.status, 400);
  });
});

describe('NUL in a query string', () => {
  it('refuses a value on the API', async () => {
    await assertRejected(await fetch(`${base}/api/v1/attendee/pass?x=a%00b`));
  });

  it('refuses a key on the API', async () => {
    await assertRejected(await fetch(`${base}/api/v1/attendee/pass?a%00b=1`));
  });

  it('refuses a value on a web page', async () => {
    const res = await fetch(`${base}/checkin?audience=a%00b`, {
      redirect: 'manual',
    });

    assert.equal(res.status, 400);
  });
});

describe('NUL in a form body', () => {
  /** Posts the continue form of `/checkin`. */
  const postForm = (body: string): Promise<Response> =>
    fetch(`${base}/checkin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: ORIGIN,
      },
      body,
      redirect: 'manual',
    });

  it('refuses a field value', async () => {
    assert.equal((await postForm('t=a%00b')).status, 400);
  });

  it('refuses a field name', async () => {
    assert.equal((await postForm('a%00b=1')).status, 400);
  });

  it('does not refuse a form without one', async () => {
    assert.notEqual((await postForm('t=abc')).status, 400);
  });
});

describe('/client-errors', () => {
  it('still strips the byte instead of refusing it', async () => {
    const res = await postJson(
      '/client-errors',
      '{"message":"a\\u0000b","url":"/","kind":"error"}',
    );

    assert.notEqual(res.status, 400);
  });
});

describe('rejectNulInput', () => {
  /** Runs the check on a request and returns what it passed on. */
  const run = (req: { query?: unknown; body?: unknown }): unknown => {
    let passed: unknown = 'not called';

    rejectNulInput(req as never, {} as never, (err?: unknown) => {
      passed = err;
    });

    return passed;
  };

  it('passes ordinary input, including other control characters', () => {
    assert.equal(
      run({
        query: { q: 'a\tb', n: ['1', '2'] },
        body: { a: { b: ['\u0001é'] } },
      }),
      undefined,
    );
  });

  it('passes a request with no body and an empty query', () => {
    assert.equal(run({ query: {}, body: undefined }), undefined);
  });

  it('refuses a NUL in an array of strings', () => {
    assert.ok(
      run({ query: { q: ['ok', 'a\u0000'] } }) instanceof ValidationError,
    );
  });

  it('refuses a NUL in a bare string body', () => {
    assert.ok(run({ query: {}, body: 'a\u0000' }) instanceof ValidationError);
  });

  it('finds a NUL under thousands of levels of nesting without overflowing', () => {
    let body: unknown = 'x\u0000';

    for (let i = 0; i < 20_000; i += 1) body = [body];

    assert.ok(run({ query: {}, body }) instanceof ValidationError);
  });
});
