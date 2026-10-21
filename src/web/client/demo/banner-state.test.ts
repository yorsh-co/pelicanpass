import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bannerState } from './banner-state.ts';

describe('bannerState', () => {
  it('prefers a stored choice over the viewport', () => {
    assert.equal(bannerState('expanded', true), 'expanded');
    assert.equal(bannerState('collapsed', false), 'collapsed');
  });

  it('collapses on a narrow viewport and expands on a wide one', () => {
    assert.equal(bannerState(null, true), 'collapsed');
    assert.equal(bannerState(null, false), 'expanded');
  });

  it('ignores a stored value that is not a banner state', () => {
    assert.equal(bannerState('open', true), 'collapsed');
    assert.equal(bannerState('', false), 'expanded');
  });
});
