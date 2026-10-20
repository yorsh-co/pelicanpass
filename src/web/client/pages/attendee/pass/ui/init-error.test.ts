import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { passInitErrorMessage } from './init-error.ts';

const copy = {
  rateLimited: 'rate limited',
  unknownError: 'unknown',
};

describe('passInitErrorMessage', () => {
  it('returns the copy for a known code', () => {
    assert.equal(passInitErrorMessage(copy, 'RATE_LIMITED'), 'rate limited');
  });

  it('returns the unknown-error copy for an unknown code', () => {
    assert.equal(passInitErrorMessage(copy, 'SOMETHING_ELSE'), 'unknown');
  });

  it('does not read inherited properties of the flash table', () => {
    for (const code of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ]) {
      assert.equal(passInitErrorMessage(copy, code), 'unknown', code);
    }
  });
});
