import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../../../../core/api/api.error.ts';
import { presenceErrorMessage } from './presence-error.ts';

import type { ApiErrorCode } from '../../../../core/api/api.error.ts';

const copy = { presenceNotYet: 'not yet', presenceError: 'error' };

describe('presenceErrorMessage', () => {
  it('says the check-in is not confirmed yet for NOT_MARKED_PRESENT', () => {
    const err = new ApiError('Not marked present', {
      status: 409,
      code: 'NOT_MARKED_PRESENT',
    });

    assert.equal(presenceErrorMessage(copy, err), 'not yet');
  });

  it('returns the generic error for any other API error', () => {
    const codes: ApiErrorCode[] = [
      'RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
      'EDGE_TIMEOUT',
    ];

    for (const code of codes) {
      const err = new ApiError('Failed', { code });

      assert.equal(presenceErrorMessage(copy, err), 'error', code);
    }
  });

  it('returns the generic error for an error that did not come from the API', () => {
    assert.equal(presenceErrorMessage(copy, new TypeError('boom')), 'error');
    assert.equal(presenceErrorMessage(copy, 'NOT_MARKED_PRESENT'), 'error');
  });
});
