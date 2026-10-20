import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  actionForClick,
  actionForKey,
  clampSlide,
  fitScale,
  navigate,
  slideFromHash,
  slideHash,
} from './navigation.ts';

describe('actionForKey', () => {
  it('maps the navigation keys', () => {
    for (const key of ['ArrowRight', 'PageDown', ' ', 'Enter'])
      assert.equal(actionForKey(key), 'next');
    for (const key of ['ArrowLeft', 'PageUp', 'Backspace'])
      assert.equal(actionForKey(key), 'prev');
    assert.equal(actionForKey('Home'), 'first');
    assert.equal(actionForKey('End'), 'last');
  });

  it('ignores other keys, including object prototype names', () => {
    assert.equal(actionForKey('a'), null);
    assert.equal(actionForKey('constructor'), null);
  });
});

describe('actionForClick', () => {
  it('goes back on the left third and forward elsewhere', () => {
    assert.equal(actionForClick(100, 0, 900), 'prev');
    assert.equal(actionForClick(300, 0, 900), 'next');
    assert.equal(actionForClick(350, 100, 900), 'prev');
    assert.equal(actionForClick(450, 100, 900), 'next');
  });
});

describe('slide hash', () => {
  it('reads one-based numbers as zero-based indexes', () => {
    assert.equal(slideFromHash('#apresentacao-1'), 0);
    assert.equal(slideFromHash('apresentacao-12'), 11);
  });

  it('rejects anything else', () => {
    for (const hash of [
      '',
      '#checkin',
      '#apresentacao-0',
      '#apresentacao-',
      '#apresentacao-2x',
      '#apresentacao--1',
    ])
      assert.equal(slideFromHash(hash), null);
  });

  it('round-trips', () => {
    assert.equal(slideFromHash(slideHash(4)), 4);
  });
});

describe('navigate', () => {
  it('moves within the deck and stops at either end', () => {
    assert.equal(navigate('next', 1, 5), 2);
    assert.equal(navigate('next', 4, 5), 4);
    assert.equal(navigate('prev', 0, 5), 0);
    assert.equal(navigate('prev', 3, 5), 2);
    assert.equal(navigate('first', 3, 5), 0);
    assert.equal(navigate('last', 1, 5), 4);
  });

  it('clamps out-of-range indexes', () => {
    assert.equal(clampSlide(99, 12), 11);
    assert.equal(clampSlide(-3, 12), 0);
  });
});

describe('fitScale', () => {
  it('fits the limiting dimension', () => {
    assert.equal(fitScale(1920, 1080), 1);
    assert.equal(fitScale(960, 1080), 0.5);
    assert.equal(fitScale(3840, 1080), 1);
  });
});
