import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fillCopyPlaceholders } from './copy-placeholders.ts';

describe('fillCopyPlaceholders', () => {
  it('replaces every occurrence of a placeholder', () => {
    assert.equal(
      fillCopyPlaceholders('{eventName} e {eventName}', { eventName: 'X' }),
      'X e X',
    );
  });

  it('replaces several keys', () => {
    assert.equal(
      fillCopyPlaceholders('{a} / {b}', { a: '1', b: '2' }),
      '1 / 2',
    );
  });

  it('fills from the defaults when no values are given', () => {
    assert.equal(fillCopyPlaceholders('{eventName}'), 'PelicanPass');
  });

  it('throws naming an unknown placeholder and the file', () => {
    assert.throws(
      () => fillCopyPlaceholders('olá {nope}', { a: '1' }, 'notice.md'),
      /notice\.md: unknown copy placeholder \{nope\}/,
    );
  });

  it('does not treat inherited object keys as values', () => {
    assert.throws(() => fillCopyPlaceholders('{toString}', {}), /\{toString\}/);
  });

  it('leaves text without placeholders unchanged', () => {
    const text = 'Texto { solto } e {} e {1a} sem marcadores.';

    assert.equal(fillCopyPlaceholders(text, {}), text);
  });

  it('leaves bracket markers untouched', () => {
    assert.equal(
      fillCopyPlaceholders('[RAZÃO SOCIAL] {a}', { a: '1' }),
      '[RAZÃO SOCIAL] 1',
    );
  });
});
