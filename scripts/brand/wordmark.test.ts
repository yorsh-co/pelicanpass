import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PRIMARY_VIEWBOX,
  primaryWordmark,
  secondaryWordmark,
  SECONDARY_VIEWBOX,
  twoToneWordmark,
} from './wordmark.ts';

/**
 * Bounds of the numbers in a path's `d`. Every command is absolute and
 * coordinates alternate x, y, so control points are included: a conservative
 * superset of the drawn ink.
 */
const pathBounds = (d: string) => {
  const numbers = (d.match(/-?[\d.]+/g) ?? []).map(Number);
  const xs = numbers.filter((_, i) => i % 2 === 0);
  const ys = numbers.filter((_, i) => i % 2 === 1);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
};

const pathsOf = (svg: string): string[] =>
  [...svg.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1] ?? '');

for (const [name, render, viewBox] of [
  ['secondary', secondaryWordmark, SECONDARY_VIEWBOX],
  ['two-tone', twoToneWordmark, SECONDARY_VIEWBOX],
  ['primary', primaryWordmark, PRIMARY_VIEWBOX],
] as const) {
  describe(`${name} wordmark`, () => {
    const svg = render();

    it('has the exact viewBox', () => {
      assert.ok(
        svg.includes(
          `viewBox="0 0 ${String(viewBox.width)} ${String(viewBox.height)}"`,
        ),
      );
    });

    it('is outlined, with no live text', () => {
      assert.doesNotMatch(svg, /<text|<tspan|font-family/);
    });
  });
}

describe('secondary wordmark', () => {
  const svg = secondaryWordmark();

  it('is a single path in a single fill', () => {
    assert.equal(pathsOf(svg).length, 1);
    assert.equal(svg.match(/fill="/g)?.length, 1);
  });

  it('keeps its ink inside the viewBox and centred', () => {
    const [d = ''] = pathsOf(svg);
    const { minX, maxX, minY, maxY } = pathBounds(d);

    assert.ok(minX >= 0 && maxX <= SECONDARY_VIEWBOX.width);
    assert.ok(minY >= 0 && maxY <= SECONDARY_VIEWBOX.height);
    assert.ok(Math.abs(minX - (SECONDARY_VIEWBOX.width - maxX)) < 1);
    assert.ok(Math.abs(minY - (SECONDARY_VIEWBOX.height - maxY)) < 1);
  });
});

describe('two-tone wordmark', () => {
  const svg = twoToneWordmark();

  it('is two paths: white "Pelican", then Shallows "Pass"', () => {
    assert.equal(pathsOf(svg).length, 2);
    assert.deepEqual(
      [...svg.matchAll(/fill="([^"]+)"/g)].map((match) => match[1]),
      ['#FFFFFF', '#CFE6E8'],
    );
  });

  it('keeps its ink inside the viewBox', () => {
    for (const d of pathsOf(svg)) {
      const { minX, maxX, minY, maxY } = pathBounds(d);

      assert.ok(minX >= 0 && maxX <= SECONDARY_VIEWBOX.width);
      assert.ok(minY >= 0 && maxY <= SECONDARY_VIEWBOX.height);
    }
  });

  it('has the same overall ink bounds as the secondary', () => {
    const union = (markup: string) => pathBounds(pathsOf(markup).join(''));

    assert.deepEqual(union(svg), union(secondaryWordmark()));
  });
});

describe('primary wordmark', () => {
  const svg = primaryWordmark();

  it('sets "Pelican" white and "Pass" Shallows beside the mark', () => {
    const [pelican, pass] = [...svg.matchAll(/<path d="[^"]+" fill="([^"]+)"/g)]
      .map((match) => match[1])
      .slice(-2);

    assert.equal(pelican, '#FFFFFF');
    assert.equal(pass, '#CFE6E8');
    assert.match(svg, /fill="#F5A524"/);
  });

  it('keeps the lettering inside the viewBox', () => {
    for (const d of pathsOf(svg).slice(-2)) {
      const { minX, maxX, minY, maxY } = pathBounds(d);

      assert.ok(minX >= 0 && maxX <= PRIMARY_VIEWBOX.width);
      assert.ok(minY >= 0 && maxY <= PRIMARY_VIEWBOX.height);
    }
  });
});
