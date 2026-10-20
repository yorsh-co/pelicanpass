import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readEntryTokens } from './entry-token.ts';

const ORIGIN = 'https://example.test';

describe('readEntryTokens', () => {
  it('returns a ticket token and strips it', () => {
    const { tokens, cleanPath } = readEntryTokens(`${ORIGIN}/checkin?t=abc`);

    assert.deepEqual(tokens, { t: 'abc' });
    assert.equal(cleanPath, '/checkin');
  });

  it('returns a poster token and strips it', () => {
    const { tokens, cleanPath } = readEntryTokens(`${ORIGIN}/checkin?k=xyz`);

    assert.deepEqual(tokens, { k: 'xyz' });
    assert.equal(cleanPath, '/checkin');
  });

  it('returns and strips both when both are present', () => {
    const { tokens, cleanPath } = readEntryTokens(
      `${ORIGIN}/checkin?t=abc&k=xyz`,
    );

    assert.deepEqual(tokens, { t: 'abc', k: 'xyz' });
    assert.equal(cleanPath, '/checkin');
  });

  it('keeps the audience and the hash', () => {
    const { cleanPath } = readEntryTokens(
      `${ORIGIN}/checkin?t=abc&audience=volunteer#top`,
    );

    assert.equal(cleanPath, '/checkin?audience=volunteer#top');
  });

  it('does not return a repeated parameter but still strips it', () => {
    const { tokens, cleanPath } = readEntryTokens(
      `${ORIGIN}/checkin?t=a&t=b&audience=volunteer`,
    );

    assert.deepEqual(tokens, {});
    assert.equal(cleanPath, '/checkin?audience=volunteer');
  });

  it('does not return an empty value but still strips it', () => {
    const { tokens, cleanPath } = readEntryTokens(`${ORIGIN}/checkin?t=&k=`);

    assert.deepEqual(tokens, {});
    assert.equal(cleanPath, '/checkin');
  });

  it('leaves a URL without tokens unchanged', () => {
    const { tokens, cleanPath } = readEntryTokens(
      `${ORIGIN}/checkin?audience=volunteer`,
    );

    assert.deepEqual(tokens, {});
    assert.equal(cleanPath, '/checkin?audience=volunteer');
  });
});
