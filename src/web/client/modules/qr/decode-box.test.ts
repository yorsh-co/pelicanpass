import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_DECODE_SIDE,
  DECODE_MARGIN,
  MIN_DECODE_SIDE,
  decodeBoxSide,
} from './decode-box.ts';

describe('decodeBoxSide', () => {
  it('adds a margin around the drawn viewfinder', () => {
    assert.equal(decodeBoxSide(272, 633, 844), 326);
  });

  it('stays within the smaller side of the video box', () => {
    assert.equal(decodeBoxSide(272, 300, 844), 300);
    assert.equal(decodeBoxSide(272, 633, 310), 310);
  });

  it('assumes the default viewfinder when unmeasured', () => {
    const expected = Math.floor(DEFAULT_DECODE_SIDE * DECODE_MARGIN);

    assert.equal(decodeBoxSide(0, 633, 844), expected);
    assert.equal(decodeBoxSide(Number.NaN, 633, 844), expected);
  });

  it('never goes below the library minimum', () => {
    assert.equal(decodeBoxSide(10, 633, 844), MIN_DECODE_SIDE);
  });

  it('never exceeds a box smaller than the minimum', () => {
    assert.equal(decodeBoxSide(272, 40.9, 844), 40);
  });
});
