import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCsv, parseTable, unguard } from './csv.ts';

describe('parseCsv', () => {
  it('reads BOM, CRLF, quoted commas, escaped quotes and line breaks', () => {
    const text = '﻿a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\r\n';

    assert.deepEqual(parseCsv(text), [
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', 'z'],
    ]);
  });

  it('reads LF endings, a missing final newline and empty cells', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,,3'), [
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  it('skips blank lines and reads an empty file as no rows', () => {
    assert.deepEqual(parseCsv('a\n\n1\n'), [['a'], ['1']]);
    assert.deepEqual(parseCsv(''), []);
  });
});

describe('parseTable', () => {
  it('keys records by trimmed header and pads short rows', () => {
    assert.deepEqual(parseTable('a, b\n1\n').records, [{ a: '1', b: '' }]);
  });
});

describe('unguard', () => {
  it('strips the guard only before formula characters', () => {
    assert.equal(unguard("'=SUM(A1)"), '=SUM(A1)');
    assert.equal(unguard("'-1"), '-1');
    assert.equal(unguard("'\tx"), '\tx');
    assert.equal(unguard("'plain"), "'plain");
    assert.equal(unguard('plain'), 'plain');
  });
});
