import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bannerLanguage } from './banner-language.ts';

describe('bannerLanguage', () => {
  it('prefers a stored choice over the browser', () => {
    assert.equal(bannerLanguage('en', 'pt-BR'), 'en');
    assert.equal(bannerLanguage('pt', 'en-US'), 'pt');
  });

  it('follows a Portuguese browser, whatever its case', () => {
    assert.equal(bannerLanguage(null, 'pt-BR'), 'pt');
    assert.equal(bannerLanguage(null, 'PT'), 'pt');
  });

  it('gives English to any other browser language', () => {
    assert.equal(bannerLanguage(null, 'en-US'), 'en');
    assert.equal(bannerLanguage(null, 'fr'), 'en');
  });

  it('ignores a stored value that is not a banner language', () => {
    assert.equal(bannerLanguage('de', 'en-US'), 'en');
    assert.equal(bannerLanguage('', 'pt-BR'), 'pt');
  });

  it('gives Portuguese, the app language, when the browser has none', () => {
    assert.equal(bannerLanguage(null, undefined), 'pt');
    assert.equal(bannerLanguage(null, ''), 'pt');
  });
});
