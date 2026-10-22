import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOCALES, dateTimeLocale, supportedLocales } from './locales.ts';

describe('supportedLocales', () => {
  it('offers pt-BR and en in production, and no pseudo-locale', () => {
    assert.deepEqual(supportedLocales('production'), ['pt-BR', 'en']);
  });

  it('offers every locale outside production', () => {
    assert.deepEqual(supportedLocales('development'), LOCALES);
  });
});

describe('dateTimeLocale', () => {
  it('formats every English tag in British conventions', () => {
    for (const tag of ['en', 'en-US', 'en-XA']) {
      assert.equal(dateTimeLocale(tag), 'en-GB');
    }
  });

  it('leaves other locales unchanged', () => {
    assert.equal(dateTimeLocale('pt-BR'), 'pt-BR');
  });

  it('writes English dates day-first and times in 24 hours', () => {
    const format = new Intl.DateTimeFormat(dateTimeLocale('en'), {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'America/Sao_Paulo',
    });

    assert.equal(
      format.format(new Date('2026-11-14T13:30:00Z')),
      '14/11/2026, 10:30',
    );
  });
});
