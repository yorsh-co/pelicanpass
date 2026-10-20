import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { createRetapMarker, RETAP_WINDOW_MS } from './retap.ts';

import type { RetapMarker } from './retap.ts';

describe('createRetapMarker', () => {
  let clock: number;
  let marker: RetapMarker;

  beforeEach(() => {
    clock = 1_000_000;
    marker = createRetapMarker(() => clock);
  });

  it('matches a re-tap of the same action inside the window', () => {
    marker.mark('h1:tshirt');
    clock += RETAP_WINDOW_MS;

    assert.equal(marker.take('h1:tshirt'), true);
  });

  it('does not match a different action', () => {
    marker.mark('h1:tshirt');

    assert.equal(marker.take('h1:meal'), false);
  });

  it('does not match once the window has passed', () => {
    marker.mark('h1:tshirt');
    clock += RETAP_WINDOW_MS + 1;

    assert.equal(marker.take('h1:tshirt'), false);
  });

  it('forgets the mark once read, matched or not', () => {
    marker.mark('h1:tshirt');

    assert.equal(marker.take('h1:tshirt'), true);
    assert.equal(marker.take('h1:tshirt'), false);

    marker.mark('h1:tshirt');
    marker.take('h1:meal');

    assert.equal(marker.take('h1:tshirt'), false);
  });

  it('matches nothing before a mark', () => {
    assert.equal(marker.take('h1:tshirt'), false);
  });
});
