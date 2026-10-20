import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { initErrorMessage } from './init-error.ts';

const copy = {
  error: { NOT_FOUND: 'not found' },
  unknownError: 'unknown',
  recoverableError: 'recoverable',
};

describe('initErrorMessage', () => {
  it('returns the copy for a known code', () => {
    assert.equal(initErrorMessage(copy, 'NOT_FOUND'), 'not found');
  });

  it('returns the unknown-error copy for an unknown code', () => {
    assert.equal(initErrorMessage(copy, 'SOMETHING_ELSE'), 'unknown');
  });

  it('does not read inherited properties of the copy table', () => {
    for (const code of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ]) {
      assert.equal(initErrorMessage(copy, code), 'unknown', code);
    }
  });
});
