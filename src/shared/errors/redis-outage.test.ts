import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRedisOutage } from './redis-outage.ts';

describe('isRedisOutage', () => {
  it('recognises what ioredis rejects with while the server is down', () => {
    for (const message of [
      "Stream isn't writeable and enableOfflineQueue options is false",
      'Connection is closed.',
      'Command timed out',
    ]) {
      assert.equal(isRedisOutage(new Error(message)), true, message);
    }
  });

  it('recognises MaxRetriesPerRequestError by name', () => {
    const err = new Error('Reached the max retries per request limit');

    err.name = 'MaxRetriesPerRequestError';

    assert.equal(isRedisOutage(err), true);
  });

  it('recognises an unreachable socket by its code', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']) {
      assert.equal(
        isRedisOutage(Object.assign(new Error('connect failed'), { code })),
        true,
        code,
      );
    }
  });

  it('leaves a server-side Redis error and anything else alone', () => {
    assert.equal(isRedisOutage(new Error('WRONGTYPE Operation')), false);
    assert.equal(
      isRedisOutage(new Error('NOAUTH Authentication required')),
      false,
    );
    assert.equal(isRedisOutage(new TypeError('x is undefined')), false);
    assert.equal(isRedisOutage('Connection is closed.'), false);
    assert.equal(isRedisOutage(undefined), false);
  });
});
