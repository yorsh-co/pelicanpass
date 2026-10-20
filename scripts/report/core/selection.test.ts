import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SLIDE_IDS } from './deck.ts';
import {
  canStart,
  landingSlide,
  normaliseExcluded,
  selectSlides,
  toggleExcluded,
} from './selection.ts';

import type { SlideId } from './deck.ts';

const OUTLINE: SlideId[] = ['cover', 'attendance', 'ages', 'closing'];

describe('selectSlides', () => {
  it('keeps the outline order', () => {
    assert.deepEqual(selectSlides(OUTLINE, ['attendance']), [
      'cover',
      'ages',
      'closing',
    ]);
  });

  it('keeps everything when nothing is excluded', () => {
    assert.deepEqual(selectSlides(OUTLINE, []), OUTLINE);
  });

  it('returns nothing when everything is excluded', () => {
    assert.deepEqual(selectSlides(OUTLINE, [...SLIDE_IDS]), []);
  });

  it('can exclude the cover and the closing', () => {
    assert.deepEqual(selectSlides(OUTLINE, ['cover', 'closing']), [
      'attendance',
      'ages',
    ]);
  });

  it('ignores excluded ids absent from the outline', () => {
    assert.deepEqual(selectSlides(OUTLINE, ['areas']), OUTLINE);
  });
});

describe('toggleExcluded', () => {
  it('adds an id', () => {
    assert.deepEqual(toggleExcluded([], 'ages'), ['ages']);
  });

  it('removes an id', () => {
    assert.deepEqual(toggleExcluded(['ages', 'closing'], 'ages'), ['closing']);
  });

  it('returns the canonical order', () => {
    assert.deepEqual(toggleExcluded(['closing', 'cover'], 'ages'), [
      'cover',
      'ages',
      'closing',
    ]);
  });

  it('does not mutate its input', () => {
    const input: SlideId[] = ['closing'];

    toggleExcluded(input, 'cover');
    assert.deepEqual(input, ['closing']);
  });
});

describe('normaliseExcluded', () => {
  it('keeps a valid array', () => {
    assert.deepEqual(normaliseExcluded(['cover', 'ages']), ['cover', 'ages']);
  });

  it('drops unknown ids and non-strings', () => {
    assert.deepEqual(normaliseExcluded(['nope', 'ages', 3, null, {}]), [
      'ages',
    ]);
  });

  it('removes duplicates', () => {
    assert.deepEqual(normaliseExcluded(['ages', 'ages', 'cover']), [
      'cover',
      'ages',
    ]);
  });

  it('sorts into deck order', () => {
    assert.deepEqual(normaliseExcluded(['closing', 'cover', 'ages']), [
      'cover',
      'ages',
      'closing',
    ]);
  });

  it('gives an empty list for anything but an array', () => {
    for (const junk of [undefined, null, 'cover', 7, true, { 0: 'cover' }]) {
      assert.deepEqual(normaliseExcluded(junk), []);
    }
  });
});

describe('canStart', () => {
  it('is true while a slide remains', () => {
    assert.equal(canStart(OUTLINE, ['cover']), true);
  });

  it('is false when every slide is excluded', () => {
    assert.equal(canStart(OUTLINE, OUTLINE), false);
  });

  it('is false for an empty outline', () => {
    assert.equal(canStart([], []), false);
  });
});

describe('landingSlide', () => {
  const before: SlideId[] = [
    'cover',
    'attendance',
    'resumo',
    'resumo',
    'closing',
  ];

  it('stays on the same slide when it is still selected', () => {
    assert.equal(landingSlide(before, 4, ['cover', 'resumo', 'closing']), 2);
  });

  it('keeps the page of a multi-page slide', () => {
    assert.equal(landingSlide(before, 3, ['resumo', 'resumo', 'closing']), 1);
  });

  it('clamps the page when the slide has fewer pages', () => {
    assert.equal(landingSlide(before, 3, ['cover', 'resumo']), 1);
  });

  it('moves to the nearest following slide when it was dropped', () => {
    assert.equal(landingSlide(before, 1, ['cover', 'resumo', 'closing']), 1);
  });

  it('moves to the last slide when nothing follows', () => {
    assert.equal(landingSlide(before, 4, ['cover', 'attendance']), 1);
  });

  it('returns 0 for an empty deck', () => {
    assert.equal(landingSlide(before, 1, []), 0);
  });
});
