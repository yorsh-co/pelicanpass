/**
 * Reading an importer's input from stdin, within limits.
 *
 * Shared by `scripts/db/import-attendees.ts` and
 * `scripts/db/set-volunteer-permissions.ts`. A roster is a few hundred rows;
 * these bounds only stop a broken or hostile export from exhausting the
 * operator's host. Everything is checked before the CSV parser sees a byte.
 *
 * **Pure, and must stay so**, like `admin.attendees.rules.ts`: the importers
 * run with only the migrator's credentials in their environment.
 */

/** Largest input accepted, in bytes. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** Most data rows accepted, header and blank lines excluded. */
export const MAX_IMPORT_ROWS = 5_000;

const NUL = '\0';

/**
 * Reads the whole input as UTF-8 text, or refuses it.
 *
 * Refused, with a message for the operator:
 *
 * - **Over {@link MAX_IMPORT_BYTES}.** Reading stops at the first chunk that
 *   crosses the limit, so an endless stream is never buffered.
 * - **A NUL byte**, named by its line. It is not stripped: a cell that changes
 *   silently on its way in is not the cell the operator reviewed.
 * - **More than {@link MAX_IMPORT_ROWS} data rows.** Counted as non-blank
 *   lines after the header, so a quoted cell that spans lines counts each line.
 *
 * A UTF-8 byte-order mark is kept; the CSV parser drops it.
 *
 * @param source - The stream to read, normally `process.stdin`.
 * @throws {Error} Naming the limit that was crossed.
 */
export const readImportInput = async (
  source: AsyncIterable<Buffer | string>,
): Promise<string> => {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of source) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;

    bytes += buffer.length;

    if (bytes > MAX_IMPORT_BYTES) {
      throw new Error('Input is larger than 2 MB; nothing was read further');
    }

    chunks.push(buffer);
  }

  const input = Buffer.concat(chunks).toString('utf8');
  const nul = input.indexOf(NUL);

  if (nul !== -1) {
    const line = input.slice(0, nul).split('\n').length;

    throw new Error(`line ${String(line)}: contains a NUL byte`);
  }

  const lines = input.split('\n').filter((line) => line.trim() !== '').length;
  const rows = Math.max(lines - 1, 0);

  if (rows > MAX_IMPORT_ROWS) {
    throw new Error(
      `Input has ${rows.toLocaleString('en-US')} data rows; the limit is ${MAX_IMPORT_ROWS.toLocaleString('en-US')}`,
    );
  }

  return input;
};
