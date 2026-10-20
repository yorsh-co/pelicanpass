import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeSendError } from './whatsapp.errors.ts';

describe('describeSendError', () => {
  it('reports the code and message of a dropped connection', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET',
      }),
    });

    assert.deepEqual(describeSendError(error), {
      title: 'TypeError',
      cause: 'UND_ERR_SOCKET: other side closed',
    });
  });

  it('reports the message when the cause has no code', () => {
    const error = new TypeError('fetch failed', {
      cause: new Error('other side closed'),
    });

    assert.equal(describeSendError(error).cause, 'other side closed');
  });

  it('reports the code when the cause has an empty message', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new AggregateError([]), { code: 'ECONNREFUSED' }),
    });

    assert.equal(describeSendError(error).cause, 'ECONNREFUSED');
  });

  it('has no cause for a timeout', () => {
    assert.deepEqual(
      describeSendError(new DOMException('timed out', 'TimeoutError')),
      { title: 'TimeoutError', cause: null },
    );
  });

  it('ignores a cause that is not an object', () => {
    const error = new TypeError('fetch failed', { cause: 'ECONNRESET' });

    assert.equal(describeSendError(error).cause, null);
  });

  it('names a non-Error throw a NetworkError', () => {
    assert.deepEqual(describeSendError('boom'), {
      title: 'NetworkError',
      cause: null,
    });
  });
});
