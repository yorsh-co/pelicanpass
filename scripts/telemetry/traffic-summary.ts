/**
 * Prints an anonymous summary of the app's request log, for keeping after
 * teardown when the log itself is not kept. Reads the log on stdin; writes
 * Markdown on stdout. See `traffic.ts` for what it counts, and
 * docs/operations/deployment.md § Teardown for when it runs.
 *
 *   docker compose logs app --no-log-prefix \
 *     | docker compose exec -T app node scripts/telemetry/traffic-summary.ts \
 *     > traffic-summary.md
 */

import { createInterface } from 'node:readline';

import { createTally, renderSummary } from './traffic.ts';

const tally = createTally();

for await (const line of createInterface({ input: process.stdin })) {
  tally.add(line);
}

const summary = tally.result();

if (summary.requests === 0) {
  console.error(
    'No request lines on stdin: pipe in `docker compose logs app --no-log-prefix`.',
  );
  process.exit(1);
}

process.stdout.write(renderSummary(summary));
