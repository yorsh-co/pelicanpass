/**
 * Writes docs/performance/load-test-results.md from every session file in
 * `loadtest/history/`. Method: docs/performance/load-testing.md, "How a session is
 * recorded and judged".
 *
 * The output is deterministic and committed. `--check` fails when the
 * committed document differs from what would be written, so a new session
 * has to regenerate it. `--csv` prints every session as one CSV instead, for
 * a spreadsheet.
 *
 * Usage:
 *   node scripts/loadtest/report.ts            write the document
 *   node scripts/loadtest/report.ts --check    fail if it is stale
 *   node scripts/loadtest/report.ts --csv      every rung, as one CSV
 */

import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';

import { parseCsv, toCsv } from './history/csv.ts';
import { renderReport } from './history/render.ts';

const HISTORY = 'loadtest/history/*.csv';
const OUTPUT = 'docs/performance/load-test-results.md';

const rows = globSync(HISTORY)
  .sort()
  .flatMap((file) => {
    try {
      return parseCsv(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });

if (argv.includes('--csv')) {
  stdout.write(toCsv(rows));
} else {
  const document = renderReport(rows);

  if (argv.includes('--check')) {
    const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';

    if (committed !== document) {
      console.error(
        `loadtest: ${OUTPUT} is stale; run \`npm run loadtest:report\` (see docs/performance/load-testing.md)`,
      );
      exit(1);
    }

    console.log('✓ load-test results are fresh');
  } else {
    writeFileSync(OUTPUT, document);
    console.log(`wrote ${OUTPUT}`);
  }
}
