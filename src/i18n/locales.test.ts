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
  it('defaults English to British, on the 24-hour clock', () => {
    assert.equal(dateTimeLocale('en', []), 'en-GB-u-hc-h23');
    assert.equal(dateTimeLocale('en'), 'en-GB-u-hc-h23');
    assert.equal(dateTimeLocale('en', ['en']), 'en-GB-u-hc-h23');
  });

  it("follows the visitor's first English region", () => {
    assert.equal(dateTimeLocale('en', ['en-US']), 'en-US-u-hc-h23');
    assert.equal(
      dateTimeLocale('en', ['pt-BR', 'en-AU', 'en-US']),
      'en-AU-u-hc-h23',
    );
  });

  it('ignores tags that do not parse', () => {
    assert.equal(dateTimeLocale('en', ['*', 'en-US']), 'en-US-u-hc-h23');
  });

  it('treats the pseudo-locale as English', () => {
    assert.equal(dateTimeLocale('en-XA'), 'en-GB-u-hc-h23');
    assert.equal(dateTimeLocale('en-XA', ['en-US']), 'en-US-u-hc-h23');
  });

  it('leaves other locales unchanged', () => {
    assert.equal(dateTimeLocale('pt-BR'), 'pt-BR');
    assert.equal(dateTimeLocale('pt-BR', ['en-US']), 'pt-BR');
  });

  it('orders the date by region and always writes 24 hours', () => {
    const format = (preferred: string[]) =>
      new Intl.DateTimeFormat(dateTimeLocale('en', preferred), {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'America/Sao_Paulo',
      }).format(new Date('2026-11-14T13:30:00Z'));

    assert.equal(format([]), '14/11/2026, 10:30');
    assert.equal(format(['en-US']), '11/14/26, 10:30');
  });
});
