import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tshirtRedeemResult } from './admin.tshirts.service.ts';
import { ConflictError } from '../../shared/errors/app-error.ts';

const AT = new Date('2026-10-03T18:30:00.123Z');

describe('tshirtRedeemResult', () => {
  it('reports a hand-over with the time and size', () => {
    assert.deepEqual(tshirtRedeemResult('redeemed', AT, 'M'), {
      outcome: 'redeemed',
      redeemedAt: AT,
      size: 'M',
    });
  });

  it('reports a duplicate with the original time', () => {
    assert.deepEqual(tshirtRedeemResult('duplicate', AT, 'GG'), {
      outcome: 'duplicate',
      redeemedAt: AT,
      size: 'GG',
    });
  });

  it('refuses an attendee with no T-shirt', () => {
    assert.throws(
      () => tshirtRedeemResult('not_entitled', null, null),
      (err: unknown) =>
        err instanceof ConflictError &&
        err.details?.reason === 'itemNotEntitled',
    );
  });
});
