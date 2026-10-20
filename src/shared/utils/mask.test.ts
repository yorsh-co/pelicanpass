import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { maskUrlSecrets } from './mask.ts';

describe('maskUrlSecrets', () => {
  it('masks the landing bypass token and keeps other parameters', () => {
    assert.equal(
      maskUrlSecrets('/?preview=abc&x=1'),
      '/?preview=[REDACTED]&x=1',
    );
  });

  it('masks the landing bypass token when it is not the first parameter', () => {
    assert.equal(
      maskUrlSecrets('/checkin?x=1&preview=abc'),
      '/checkin?x=1&preview=[REDACTED]',
    );
  });

  it('keeps the poster token visible', () => {
    assert.equal(maskUrlSecrets('/checkin?k=poster'), '/checkin?k=poster');
  });
});
