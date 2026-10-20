import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readBooleanField } from './request-body.ts';

describe('readBooleanField', () => {
  it('reads JSON booleans', () => {
    assert.equal(readBooleanField({ on: true }, 'on'), true);
    assert.equal(readBooleanField({ on: false }, 'on'), false);
  });

  it('reports an absent field as undefined', () => {
    assert.equal(readBooleanField({}, 'on'), undefined);
  });

  it('does not coerce look-alikes', () => {
    for (const value of ['true', 'false', 'on', 1, 0, null]) {
      assert.equal(
        readBooleanField({ on: value }, 'on'),
        undefined,
        JSON.stringify(value),
      );
    }
  });

  it('survives a body that is not an object', () => {
    for (const body of [undefined, null, 'on', 1]) {
      assert.equal(readBooleanField(body, 'on'), undefined);
    }
  });
});
