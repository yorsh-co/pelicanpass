import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PAGE_SIZE, parseAttendeeFilters } from './attendee-filters.ts';

const MAX_PAGE = 100_000;

const pageOf = (page: unknown): number => parseAttendeeFilters({ page }).page;

describe('parseAttendeeFilters page', () => {
  it('reads a positive integer', () => {
    assert.equal(pageOf('1'), 1);
    assert.equal(pageOf('3'), 3);
    assert.equal(pageOf(String(MAX_PAGE)), MAX_PAGE);
  });

  it('settles on page one for anything that is not a positive integer', () => {
    for (const value of ['', '0', '-1', '1.5', 'abc', '1e9', ' ', '2x', '+3']) {
      assert.equal(pageOf(value), 1, JSON.stringify(value));
    }
  });

  it('settles on page one for a repeated or absent field', () => {
    assert.equal(pageOf(['2', '3']), 1);
    assert.equal(pageOf(undefined), 1);
  });

  it('clamps a page above the cap, however large', () => {
    for (const value of [
      String(MAX_PAGE + 1),
      '9223372036854775807',
      '99999999999999999999',
      '9'.repeat(400),
    ]) {
      assert.equal(pageOf(value), MAX_PAGE, value);
    }
  });

  it('keeps the OFFSET inside a 32-bit integer for every input', () => {
    const offset = (pageOf('9223372036854775807') - 1) * PAGE_SIZE;

    assert.ok(Number.isSafeInteger(offset));
    assert.ok(offset < 2 ** 31);
  });
});
