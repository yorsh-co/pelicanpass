import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CSV_HEADER, csvLine, parseCsv, toCsv } from './csv.ts';
import { COLUMNS, LATER_COLUMNS } from './row.ts';

import type { RungRow } from './row.ts';

const EMPTY = Object.fromEntries(COLUMNS.map((c) => [c, null])) as RungRow;

const row: RungRow = {
  ...EMPTY,
  schema: 1,
  session: '2026-09-28-dev-server-46c07fa',
  rung: 'raffle-s16',
  note: 'after "hold5", a comma, and\na second line',
  cores: 16,
  wsl: false,
  scale: 16,
  served_p95: 487.25,
  dropped_rate: 0.0065,
  valid: true,
};

describe('csv', () => {
  it('round-trips a rung, quoting what needs it', () => {
    assert.deepEqual(parseCsv(toCsv([row, EMPTY])), [row, EMPTY]);
  });

  it('writes empty cells for null and keeps booleans readable', () => {
    const line = csvLine(row);

    assert.ok(
      line.startsWith(
        '1,2026-09-28-dev-server-46c07fa,raffle-s16,,"after ""hold5"", a comma',
      ),
    );
    assert.ok(line.includes(',false,'));
    assert.ok(line.endsWith(',true,'));
  });

  it('rounds fractions to four places', () => {
    const [parsed] = parseCsv(toCsv([{ ...row, dropped_rate: 2694 / 28801 }]));

    assert.equal(parsed?.dropped_rate, 0.0935);
  });

  it('reads CRLF line endings', () => {
    const text = toCsv([row])
      .replaceAll('\n', '\r\n')
      .replace('and\r\na', 'and\na');

    assert.deepEqual(parseCsv(text), [row]);
  });

  it('reads a header with no rungs', () => {
    assert.deepEqual(parseCsv(`${CSV_HEADER}\n`), []);
  });

  it('refuses another schema', () => {
    assert.throws(() => parseCsv('schema,session\n1,x\n'), /another version/);
  });

  it('reads a file from before the later columns, leaving them empty', () => {
    // A note without commas, so the line splits on its field separators.
    const plain = { ...row, note: 'plain' };
    const cells = csvLine(plain).split(',');
    const early = COLUMNS.flatMap((column, i) =>
      LATER_COLUMNS.includes(column) ? [] : [[column, cells[i] ?? '']],
    );
    const text = [
      early.map(([column]) => column).join(','),
      early.map(([, cell]) => cell).join(','),
    ].join('\n');
    const withLater = { ...row, rate_limit_overrides: 'rl:ip=600/60' };

    assert.deepEqual(parseCsv(`${text}\n`), [plain]);
    assert.deepEqual(parseCsv(toCsv([withLater])), [withLater]);
  });

  it('refuses a header missing a column that has always existed', () => {
    const header = COLUMNS.filter((c) => c !== 'served_p95').join(',');

    assert.throws(() => parseCsv(`${header}\n`), /another version/);
  });

  it('refuses a column it does not know', () => {
    assert.throws(() => parseCsv(`${CSV_HEADER},extra\n`), /another version/);
  });

  it('refuses a short line', () => {
    assert.throws(() => parseCsv(`${CSV_HEADER}\n1,x\n`), /Line 2: 2 fields/);
  });

  it('refuses a cell of the wrong type', () => {
    const text = toCsv([row]).replace(',16,,,false,', ',sixteen,,,false,');

    assert.throws(
      () => parseCsv(text),
      /"cores" must be a number, got "sixteen"/,
    );
  });
});
