import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fullBleedIcon,
  markGroup,
  markOutline,
  placeOnGrid,
  tileIcon,
} from './mark.ts';
import { MARK_SCALE } from './palette.ts';

/** Radius of the maskable safe zone: 40 % of the icon's edge. */
const SAFE_ZONE_RADIUS = 40;

const farthestFromCentre = (scale: number): number =>
  Math.max(
    ...markOutline().map((point) => {
      const { x, y } = placeOnGrid(point, scale);
      return Math.hypot(x - 50, y - 50);
    }),
  );

describe('markGroup', () => {
  it('paints neck, beak, head, eye in that order', () => {
    const group = markGroup(0.72);
    const order = ['<rect', '<path', '<circle cx="42"', '<circle cx="46"'].map(
      (tag) => group.indexOf(tag),
    );

    assert.ok(order.every((index) => index !== -1));
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
    );
  });

  it('uses the construction transform', () => {
    assert.match(
      markGroup(0.72),
      /^<g transform="translate\(50 50\) scale\(0\.72\) translate\(-57 -49\)">/,
    );
  });

  it('can omit the eye', () => {
    assert.doesNotMatch(markGroup(0.82, { eye: false }), /cx="46"/);
  });
});

describe('maskable icon', () => {
  it('keeps the whole glyph inside the 40 % safe zone', () => {
    assert.ok(farthestFromCentre(MARK_SCALE.maskable) <= SAFE_ZONE_RADIUS);
  });

  it('would leave the safe zone at the tile scale', () => {
    assert.ok(farthestFromCentre(0.92) > SAFE_ZONE_RADIUS);
  });
});

describe('icons', () => {
  it('rounds the tile and leaves the full-bleed icon square', () => {
    assert.match(tileIcon({ scale: 0.72 }), /<rect [^>]*rx="22"/);
    assert.doesNotMatch(fullBleedIcon({ scale: 0.72 }), /rx="22"/);
  });

  it('scales the 100 grid to a 1024 viewBox', () => {
    const svg = tileIcon({ scale: 0.72, viewBox: 1024 });

    assert.match(svg, /viewBox="0 0 1024 1024"/);
    assert.match(svg, /<g transform="scale\(10\.24\)">/);
  });
});
