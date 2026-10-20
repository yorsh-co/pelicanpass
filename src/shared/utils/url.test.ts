import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withQueryParam, withoutQueryParam } from './url.ts';

const HOSTILE_PATHS = [
  '//evil//x',
  '/\\evil',
  '/%2F%2Fevil',
  '///x',
  '/\\/evil',
  '//evil.example//attacker.example/x',
];

/** Asserts the result is a same-origin path: one leading `/`, then no `/` or `\`. */
const assertSingleSlash = (result: string): void => {
  assert.match(result, /^\/(?![/\\])/, result);
};

describe('withoutQueryParam', () => {
  it('keeps the other query parameters and the path', () => {
    assert.equal(
      withoutQueryParam('/checkin?lang=pt-BR&audience=volunteer', 'lang'),
      '/checkin?audience=volunteer',
    );
  });

  it('returns a bare path when nothing else is left', () => {
    assert.equal(withoutQueryParam('/pass?lang=pt-BR', 'lang'), '/pass');
  });

  for (const path of HOSTILE_PATHS) {
    it(`never returns a network-path reference for ${path}`, () => {
      assertSingleSlash(withoutQueryParam(`${path}?lang=pt-BR&a=1`, 'lang'));
    });
  }

  it('collapses the doubled slash of the reported case', () => {
    assert.equal(
      withoutQueryParam(
        '//evil.example//attacker.example/x?lang=pt-BR',
        'lang',
      ),
      '/attacker.example/x',
    );
  });
});

describe('withQueryParam', () => {
  it('keeps the other query parameters and the path', () => {
    assert.equal(
      withQueryParam('/checkin?audience=volunteer', 'lang', 'en'),
      '/checkin?audience=volunteer&lang=en',
    );
  });

  for (const path of HOSTILE_PATHS) {
    it(`never returns a network-path reference for ${path}`, () => {
      assertSingleSlash(withQueryParam(`${path}?a=1`, 'lang', 'en'));
    });
  }
});
