import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { blankItemLabel } from './blank-item-label.ts';

describe('blankItemLabel', () => {
  it('is unavailable while the item is blocked by the role', () => {
    assert.equal(blankItemLabel(true), 'unavailable');
  });

  it('is none when the item is not blocked', () => {
    assert.equal(blankItemLabel(false), 'none');
  });
});
