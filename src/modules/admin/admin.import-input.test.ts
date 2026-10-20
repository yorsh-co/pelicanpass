import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';

import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  readImportInput,
} from './admin.import-input.ts';
import { parseRosterCsv } from './admin.attendees.import.ts';

const HEADER = 'ticket_code,name,phone';

/** A file of `count` data rows under the roster header. */
const rows = (count: number): string =>
  [
    HEADER,
    ...Array.from({ length: count }, () => 'xabc12,Ana Lima,5511900001234'),
  ].join('\n');

/** Reads `chunks` through the input reader. */
const read = (...chunks: (Buffer | string)[]): Promise<string> =>
  readImportInput(Readable.from(chunks));

describe('readImportInput', () => {
  it('returns a normal file unchanged', async () => {
    const file = `${HEADER}\nxabc12,Ana Lima,5511900001234\n`;

    assert.equal(await read(file), file);
  });

  it('joins a file split across chunks', async () => {
    assert.equal(await read('ab', Buffer.from('c\n')), 'abc\n');
  });

  it('accepts exactly the byte limit', async () => {
    const file = Buffer.alloc(MAX_IMPORT_BYTES, 'a');

    assert.equal((await read(file)).length, MAX_IMPORT_BYTES);
  });

  it('refuses one byte over the limit, whatever the chunking', async () => {
    const half = Buffer.alloc(MAX_IMPORT_BYTES / 2, 'a');

    await assert.rejects(read(Buffer.alloc(MAX_IMPORT_BYTES + 1, 'a')), /2 MB/);
    await assert.rejects(read(half, half, Buffer.from('a')), /2 MB/);
  });

  it('counts bytes, not characters', async () => {
    const file = String.fromCodePoint(0xe3).repeat(MAX_IMPORT_BYTES / 2 + 1);

    await assert.rejects(read(file), /2 MB/);
  });

  it('accepts exactly the row limit', async () => {
    const file = rows(MAX_IMPORT_ROWS);

    assert.equal(await read(file), file);
  });

  it('refuses one data row over the limit', async () => {
    await assert.rejects(
      read(rows(MAX_IMPORT_ROWS + 1)),
      /5,001 data rows.*5,000/,
    );
  });

  it('does not count the header, blank lines or CRLF endings as rows', async () => {
    const file = `${rows(MAX_IMPORT_ROWS)}\n\n\r\n`.replaceAll('\n', '\r\n');

    assert.equal(await read(file), file);
  });

  it('refuses a NUL byte and names its line', async () => {
    await assert.rejects(
      read(
        `${HEADER}\nxabc12,Ana Lima,5511900001234\nxabc13,Bia\0 Lima,5511900001235\n`,
      ),
      /line 3: .*NUL/,
    );
  });

  it('names the first NUL when there are several', async () => {
    await assert.rejects(read('a\n\0\n\0\n'), /line 2: .*NUL/);
  });

  it('accepts a UTF-8 byte-order mark, and the parser still reads it', async () => {
    const text = await read(
      Buffer.from(`\uFEFF${HEADER}\nxabc12,Ana Lima,5511900001234\n`),
    );
    const parsed = parseRosterCsv(text);

    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.rows.length, 1);
  });
});
