/**
 * Session files: one header, one line per rung, RFC 4180 quoting.
 *
 * Reading checks the header against {@link COLUMNS}, in order. A file may
 * lack only the {@link LATER_COLUMNS}, which read as empty; anything else
 * written under another schema is refused rather than read into the wrong
 * columns.
 */

import { COLUMN_KINDS, COLUMNS, LATER_COLUMNS } from './row.ts';

import type { Column, RungRow } from './row.ts';

/** Decimal places kept for fractional numbers. */
const DECIMALS = 4;

export const CSV_HEADER = COLUMNS.join(',');

const quote = (field: string): string =>
  /[",\n\r]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;

const format = (cell: RungRow[Column]): string => {
  if (cell === null) return '';
  if (typeof cell === 'number') {
    return String(
      Number.isInteger(cell) ? cell : Number(cell.toFixed(DECIMALS)),
    );
  }
  return quote(String(cell));
};

/**
 * Formats one rung as a CSV line, without the line break.
 *
 * @param row - The rung.
 */
export const csvLine = (row: RungRow): string =>
  COLUMNS.map((column) => format(row[column])).join(',');

/**
 * Formats rungs as a complete session file.
 *
 * @param rows - The rungs, in order.
 */
export const toCsv = (rows: readonly RungRow[]): string =>
  [CSV_HEADER, ...rows.map(csvLine)].map((line) => `${line}\n`).join('');

/**
 * Splits CSV text into records of raw fields, honouring quotes, doubled quotes
 * and line breaks inside quotes.
 *
 * @param text - The file's content.
 */
const records = (text: string): string[][] => {
  const out: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      out.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || record.length > 0) {
    record.push(field);
    out.push(record);
  }

  return out;
};

const parseCell = (
  column: Column,
  raw: string,
  line: number,
): RungRow[Column] => {
  if (raw === '') return null;

  const kind = COLUMN_KINDS[column];

  if (kind === 'string') return raw;

  if (kind === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } else {
    const value = Number(raw);

    if (Number.isFinite(value)) return value;
  }

  throw new Error(
    `Line ${String(line)}: "${column}" must be a ${kind}, got "${raw}"`,
  );
};

/**
 * Reads a session file.
 *
 * @param text - The file's content.
 * @throws {Error} If the header is neither this schema's nor an earlier one's,
 *   a line has the wrong number of fields, or a cell is not of its column's
 *   type.
 */
export const parseCsv = (text: string): RungRow[] => {
  const [header = [], ...lines] = records(text);
  const expected = COLUMNS.filter(
    (column) => header.includes(column) || !LATER_COLUMNS.includes(column),
  );

  if (header.join(',') !== expected.join(',')) {
    throw new Error(
      'Header does not match this schema: the file was written by another version of the runner',
    );
  }

  return lines.map((fields, index) => {
    const line = index + 2;

    if (fields.length !== header.length) {
      throw new Error(
        `Line ${String(line)}: ${String(fields.length)} fields, expected ${String(header.length)}`,
      );
    }

    return Object.fromEntries(
      COLUMNS.map((column) => {
        const at = header.indexOf(column);

        return [
          column,
          at === -1 ? null : parseCell(column, fields[at] ?? '', line),
        ];
      }),
    ) as RungRow;
  });
};
