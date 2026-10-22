import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkinAtOptions } from './checkin-at.ts';

const moment = new Date('2025-11-14T13:30:00Z');

const format = (lang: string): string =>
  new Intl.DateTimeFormat(lang, {
    ...checkinAtOptions(lang),
    timeZone: 'America/Sao_Paulo',
  }).format(moment);

describe('checkinAtOptions', () => {
  it('abbreviates the month in English, with 24-hour time', () => {
    assert.equal(format('en'), 'Nov 14, 10:30');
  });

  it('follows English for its regional and pseudo-locale tags', () => {
    assert.equal(format('en-US'), 'Nov 14, 10:30');
    assert.equal(format('en-XA'), 'Nov 14, 10:30');
  });

  it('keeps the full month name in pt-BR, with 24-hour time', () => {
    assert.match(format('pt-BR'), /^14 de novembro \S+ 10:30$/);
  });
});
