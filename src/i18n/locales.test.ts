import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOCALES, supportedLocales } from './locales.ts';

describe('supportedLocales', () => {
  it('offers pt-BR and en in production, and no pseudo-locale', () => {
    assert.deepEqual(supportedLocales('production'), ['pt-BR', 'en']);
  });

  it('offers every locale outside production', () => {
    assert.deepEqual(supportedLocales('development'), LOCALES);
  });
});
