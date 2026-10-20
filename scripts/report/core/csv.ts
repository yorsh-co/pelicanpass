/** Matches the `'` that `src/constants/csv.ts` prefixes to a formula-like cell. */
const GUARDED = /^'[=+\-@\t\r]/;

/**
 * Undoes the formula guard the exporters add to text cells.
 *
 * @param value - A text cell as parsed.
 */
export const unguard = (value: string): string =>
  GUARDED.test(value) ? value.slice(1) : value;

/**
 * Parses RFC 4180 text into rows of cells.
 *
 * Accepts CRLF or LF, a leading byte-order mark, quoted cells with `""`
 * escapes and embedded separators or line breaks, and a missing final newline.
 * Blank lines are skipped.
 *
 * @param text - The file's contents.
 */
export const parseCsv = (text: string): string[][] => {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  const endRow = (): void => {
    row.push(cell);
    cell = '';
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i++) {
    const char = source.charAt(i);

    if (quoted) {
      if (char !== '"') cell += char;
      else if (source.charAt(i + 1) === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') endRow();
    else if (char === '\r') {
      if (source.charAt(i + 1) === '\n') i++;
      endRow();
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) endRow();

  return rows;
};

/** A parsed file: its header, and each later line keyed by header. */
export interface CsvTable {
  header: string[];
  records: Record<string, string>[];
}

/**
 * Parses CSV text into records keyed by the trimmed header names.
 *
 * Short rows read as empty cells; a duplicated header keeps its last value.
 *
 * @param text - The file's contents.
 * @returns The table, with an empty header for an empty file.
 */
export const parseTable = (text: string): CsvTable => {
  const [head = [], ...body] = parseCsv(text);
  const header = head.map((name) => name.trim());
  const records = body.map((cells) =>
    Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])),
  );

  return { header, records };
};
