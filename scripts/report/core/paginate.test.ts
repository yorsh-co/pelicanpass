import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paginate } from './paginate.ts';

import type { BlockExtent } from './paginate.ts';

/** Stacks blocks of the given heights with a 10px gap. */
const stack = (...specs: (number | `h${number}`)[]): BlockExtent[] => {
  let top = 0;

  return specs.map((spec) => {
    const heading = typeof spec === 'string';
    const height = heading ? Number(spec.slice(1)) : spec;
    const block = { top, bottom: top + height, heading };

    top += height + 10;

    return block;
  });
};

describe('paginate', () => {
  it('keeps everything that fits on one page', () => {
    assert.deepEqual(paginate(stack(100, 100, 100), 400), [[0, 1, 2]]);
  });

  it('starts a new page when the next block overflows', () => {
    assert.deepEqual(paginate(stack(100, 100, 100), 250), [[0, 1], [2]]);
  });

  it('measures each page from its own first block', () => {
    assert.deepEqual(paginate(stack(100, 100, 100, 100, 100), 250), [
      [0, 1],
      [2, 3],
      [4],
    ]);
  });

  it('starts a page at a heading once the page has content', () => {
    assert.deepEqual(paginate(stack('h50', 50, 'h50', 50), 1000), [
      [0, 1],
      [2, 3],
    ]);
  });

  it('does not start an empty page for a leading heading', () => {
    assert.deepEqual(paginate(stack('h50', 50), 1000), [[0, 1]]);
  });

  it('keeps a heading with the block that follows it', () => {
    assert.deepEqual(paginate(stack('h50', 300), 200), [[0, 1]]);
  });

  it('gives an oversized block its own page', () => {
    assert.deepEqual(paginate(stack(100, 900, 100), 300), [[0], [1], [2]]);
  });

  it('returns no pages for no blocks', () => {
    assert.deepEqual(paginate([], 100), []);
  });
});
