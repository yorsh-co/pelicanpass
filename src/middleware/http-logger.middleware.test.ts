import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { requestLogLevel } from './http-logger.middleware.ts';

/** A finished response as the level decision sees it. */
const response = (
  statusCode: number,
  locals: Record<string, unknown> = {},
) => ({
  statusCode,
  locals,
});

describe('requestLogLevel', () => {
  it('logs success at info, client errors at warn and failures at error', () => {
    assert.equal(requestLogLevel(response(200)), 'info');
    assert.equal(requestLogLevel(response(429)), 'warn');
    assert.equal(requestLogLevel(response(500)), 'error');
    assert.equal(requestLogLevel(response(200), new Error('x')), 'error');
  });

  it('logs a shed 503 at warn', () => {
    assert.equal(requestLogLevel(response(503, { shed: true })), 'warn');
  });

  it('logs a 503 for an unreachable dependency at warn', () => {
    assert.equal(requestLogLevel(response(503, { degraded: true })), 'warn');
  });

  it('keeps an ordinary 503 at error', () => {
    assert.equal(requestLogLevel(response(503)), 'error');
  });
});
