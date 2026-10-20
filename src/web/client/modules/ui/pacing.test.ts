import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BAND_GRACE_MS, BAND_RETRY_MS, retryDelay } from './pacing.ts';

/** The largest value `Math.random` can return. */
const NEAR_ONE = 1 - Number.EPSILON;

describe('band pacing', () => {
  it('surfaces a stalled band before the loop retries by itself', () => {
    assert.ok(BAND_RETRY_MS - BAND_GRACE_MS > 0);
  });
});

describe('retryDelay', () => {
  it('stays within the backoff and half of it again', () => {
    assert.equal(
      retryDelay(undefined, () => 0),
      BAND_RETRY_MS,
    );

    const longest = retryDelay(undefined, () => NEAR_ONE);

    // Inclusive: at the top of the range the product rounds to exactly 1.5.
    assert.ok(longest > BAND_RETRY_MS);
    assert.ok(longest <= BAND_RETRY_MS * 1.5);
  });

  it('waits out a longer Retry-After', () => {
    assert.equal(
      retryDelay(10, () => 0),
      10_000,
    );
  });

  it('keeps its own floor over a shorter Retry-After', () => {
    assert.equal(
      retryDelay(2, () => 0),
      BAND_RETRY_MS,
    );
  });
});
