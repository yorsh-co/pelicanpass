import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { Request, Response } from 'express';

import { createSessionAdapter } from './session.adapter.ts';
import { sessionService } from './session.service.ts';
import { createCheckinSession } from '../checkin/checkin.session.model.ts';
import redis from '../../shared/db/redis.ts';

import type { CheckinSession } from '../../types/session.ts';

const COOKIE = 'test_cookie';

const adapter = createSessionAdapter<CheckinSession>(
  'checkin',
  COOKIE,
  createCheckinSession,
);

/** Cookie calls recorded against the fake response, in order. */
let calls: { op: 'cookie' | 'clearCookie'; value?: string }[];
let req: Request;
let res: Response;

/** Stubs the store so IDs are predictable and nothing reaches Redis. */
const stubStore = () => {
  const created = mock.method(sessionService, 'create', (type: string) =>
    Promise.resolve({
      sessionId: 'created-id',
      session: createCheckinSession(req),
      type,
    }),
  );
  const get = mock.method(sessionService, 'get', () =>
    Promise.resolve(createCheckinSession(req)),
  );
  const rotate = mock.method(sessionService, 'rotate', () =>
    Promise.resolve({
      sessionId: 'rotated-id',
      session: createCheckinSession(req),
    }),
  );
  const destroy = mock.method(sessionService, 'destroy', () =>
    Promise.resolve(),
  );
  return { created, get, rotate, destroy };
};

beforeEach(() => {
  calls = [];
  req = {
    cookies: { [COOKIE]: 'old-id' },
    headers: { 'user-agent': 'test' },
  } as unknown as Request;
  res = {
    cookie: (_name: string, value: string) =>
      calls.push({ op: 'cookie', value }),
    clearCookie: () => calls.push({ op: 'clearCookie' }),
  } as unknown as Response;
});

afterEach(() => {
  mock.restoreAll();
});

after(() => {
  redis.disconnect();
});

describe('session adapter request binding', () => {
  it('destroys the rotated session, not the pre-rotation ID', async () => {
    const store = stubStore();

    await adapter.rotate(req, res, 'old-id');
    await adapter.destroy(req, res);

    assert.deepEqual(store.destroy.mock.calls[0]?.arguments, [
      'checkin',
      'rotated-id',
    ]);
    assert.deepEqual(calls, [
      { op: 'cookie', value: 'rotated-id' },
      { op: 'clearCookie' },
    ]);
  });

  it('reads the rotated session after rotation', async () => {
    const store = stubStore();

    await adapter.rotate(req, res, 'old-id');
    const found = await adapter.get(req);

    assert.equal(found?.sessionId, 'rotated-id');
    assert.equal(store.get.mock.calls[0]?.arguments[1], 'rotated-id');
  });

  it('destroys the created session after create', async () => {
    const store = stubStore();
    req.cookies = {};

    await adapter.create(req, res);
    await adapter.destroy(req, res);

    assert.deepEqual(store.destroy.mock.calls[0]?.arguments, [
      'checkin',
      'created-id',
    ]);
  });

  it('does not look up a destroyed ID and binds a new session on ensure', async () => {
    const store = stubStore();

    await adapter.destroy(req, res);
    const ensured = await adapter.ensure(req, res);

    assert.equal(store.get.mock.callCount(), 0);
    assert.equal(store.created.mock.callCount(), 1);
    assert.equal(ensured.sessionId, 'created-id');
    assert.equal(req.cookies[COOKIE], 'created-id');
  });

  it('reset destroys the old ID and leaves the request on the new one', async () => {
    const store = stubStore();

    const fresh = await adapter.reset(req, res);

    assert.deepEqual(store.destroy.mock.calls[0]?.arguments, [
      'checkin',
      'old-id',
    ]);
    assert.equal(fresh.sessionId, 'created-id');
    assert.equal(req.cookies[COOKIE], 'created-id');
  });
});
