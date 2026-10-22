import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatOpensAt } from './landing-view.ts';

const OPENS_AT = Date.parse('2026-09-13T21:30:00Z');
const TIMEZONE = 'America/Sao_Paulo';

describe('formatOpensAt', () => {
  it('writes the time with a colon and no suffix in English', () => {
    const text = formatOpensAt(OPENS_AT, 'en', TIMEZONE);

    assert.match(text, /18:30/);
    assert.doesNotMatch(text, /18h30|AM|PM/);
  });

  it('keeps the pt-BR "18h30" style', () => {
    assert.match(formatOpensAt(OPENS_AT, 'pt-BR', TIMEZONE), /18h30/);
  });
});
