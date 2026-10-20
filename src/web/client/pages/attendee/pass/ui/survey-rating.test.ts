import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exceedsMax, parseRating, ratingAt } from './survey-rating.ts';

describe('ratingAt', () => {
  // A 900px track starting at x=100 spans 1..10, so each step is 100px.
  const at = (clientX: number): number => ratingAt(clientX, 100, 900, 1, 10);

  it('maps the ends of the track to the minimum and maximum', () => {
    assert.equal(at(100), 1);
    assert.equal(at(1000), 10);
  });

  it('maps the middle of the track to the nearest step', () => {
    assert.equal(at(550), 6);
  });

  it('snaps to the nearest step either side of a midpoint', () => {
    assert.equal(at(149), 1);
    assert.equal(at(151), 2);
    assert.equal(at(249), 2);
    assert.equal(at(251), 3);
    assert.equal(at(949), 9);
    assert.equal(at(951), 10);
  });

  it('clamps a pointer left of the track to the minimum', () => {
    assert.equal(at(0), 1);
    assert.equal(at(-500), 1);
  });

  it('clamps a pointer right of the track to the maximum', () => {
    assert.equal(at(1001), 10);
    assert.equal(at(5000), 10);
  });

  it('returns the minimum for a track with no width', () => {
    assert.equal(ratingAt(100, 100, 0, 1, 10), 1);
    assert.equal(ratingAt(500, 100, 0, 1, 10), 1);
  });

  it('returns the minimum for a track with a negative width', () => {
    assert.equal(ratingAt(500, 100, -50, 1, 10), 1);
  });
});

describe('parseRating', () => {
  it('reads a whole number in range', () => {
    assert.equal(parseRating('7', 1, 10), 7);
    assert.equal(parseRating('1', 1, 10), 1);
    assert.equal(parseRating('10', 1, 10), 10);
  });

  it('ignores surrounding whitespace', () => {
    assert.equal(parseRating(' 7 ', 1, 10), 7);
  });

  it('accepts a leading zero', () => {
    assert.equal(parseRating('05', 1, 10), 5);
  });

  it('rejects an empty or blank box', () => {
    assert.equal(parseRating('', 1, 10), null);
    assert.equal(parseRating('   ', 1, 10), null);
  });

  it('rejects a decimal', () => {
    assert.equal(parseRating('5.5', 1, 10), null);
  });

  it('rejects text', () => {
    assert.equal(parseRating('abc', 1, 10), null);
  });

  it('rejects signs and exponents', () => {
    assert.equal(parseRating('+5', 1, 10), null);
    assert.equal(parseRating('-5', 1, 10), null);
    assert.equal(parseRating('1e1', 1, 10), null);
  });

  it('rejects a number below the minimum', () => {
    assert.equal(parseRating('0', 1, 10), null);
  });

  it('rejects a number above the maximum', () => {
    assert.equal(parseRating('11', 1, 10), null);
  });
});

describe('exceedsMax', () => {
  it('flags a whole number above the maximum', () => {
    assert.equal(exceedsMax('11', 10), true);
    assert.equal(exceedsMax('99', 10), true);
  });

  it('flags a decimal or exponent above the maximum', () => {
    assert.equal(exceedsMax('10.5', 10), true);
    assert.equal(exceedsMax('1e2', 10), true);
  });

  it('passes the maximum and anything below it', () => {
    assert.equal(exceedsMax('10', 10), false);
    assert.equal(exceedsMax('1', 10), false);
    assert.equal(exceedsMax('010', 10), false);
  });

  it('passes an empty, blank or non-numeric box', () => {
    assert.equal(exceedsMax('', 10), false);
    assert.equal(exceedsMax(' ', 10), false);
    assert.equal(exceedsMax('abc', 10), false);
  });
});
