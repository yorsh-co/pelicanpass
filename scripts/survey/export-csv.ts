/**
 * Exports one audience's questionnaire answers as CSV, for teardown.
 *
 * **This is one of the files that outlives the deployment.** The host is torn
 * down roughly 24 hours after the event, and what survives is whatever left the
 * box before then: this file, once per audience, beside
 * `scripts/db/export-results.sql`. See docs/security/data-retention.md.
 *
 * **Anonymous, not pseudonymous** — unlike the results export. The answers are
 * stored with no attendee column and no timestamp, only the date, and are read
 * here in `response_id` order, which is random, so no row can be joined back to
 * who wrote it or when. Two limits remain, and neither is technical: a free-text
 * answer can name its author, and the **volunteer file is far easier to
 * re-identify by reading** — the group is small and known by name. Share it with
 * that in mind.
 *
 * Runs as the READ-ONLY role, which may read `survey_export` and neither table
 * beneath it. It uses the same query and the same CSV builder as the
 * administrator's download, so the two files cannot differ in rows, columns or
 * the formula guard. It loads none of the server's configuration, which is what
 * lets it run in `migrate`, the one service that holds the read-only keys.
 *
 * Columns come from the questions file, which is why this is a Node script
 * rather than SQL beside `export-results.sql`: psql cannot read Markdown.
 *
 * Usage, from the repo root, once per audience:
 *
 *   docker compose run --rm -T migrate node scripts/survey/export-csv.ts \
 *     --audience participant > survey-participant.csv
 *   docker compose run --rm -T migrate node scripts/survey/export-csv.ts \
 *     --audience volunteer > survey-volunteer.csv
 */

import 'dotenv/config';

import { argv, exit, stderr, stdout } from 'node:process';

import pkg from 'pg';

import { buildSurveyCsv } from '../../src/modules/survey/survey.csv.ts';
import { surveyFor } from '../../src/modules/survey/survey.definition.ts';
import { selectExportRows } from '../../src/modules/survey/survey.export-query.ts';

import type { AttendeeRole } from '../../src/types/attendee.ts';

const { Pool } = pkg;

const USAGE =
  'usage: node scripts/survey/export-csv.ts --audience participant|volunteer\n';

/**
 * Reads a required variable.
 *
 * @param key - Name of the environment variable.
 * @throws {Error} If it is unset or empty.
 */
const required = (key: string): string => {
  const value = process.env[key];

  if (!value) throw new Error(`Missing environment variable: ${key}`);

  return value;
};

/**
 * The audience named on the command line, or `null` if the arguments are
 * anything but exactly `--audience participant|volunteer`.
 *
 * @param args - Arguments after the script's path.
 */
const readAudience = (args: readonly string[]): AttendeeRole | null => {
  const [flag, value, ...rest] = args;

  if (flag !== '--audience' || rest.length > 0) return null;

  return value === 'participant' || value === 'volunteer' ? value : null;
};

const audience = readAudience(argv.slice(2));

if (audience === null) {
  stderr.write(USAGE);
  exit(2);
}

const pool = new Pool({
  host: required('POSTGRES_HOST'),
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  database: required('POSTGRES_DB'),
  user: required('POSTGRES_READONLY_USER'),
  password: required('POSTGRES_READONLY_PASSWORD'),
  max: 1,
  connectionTimeoutMillis: 5_000,
});

try {
  const rows = await selectExportRows(pool, required('EVENT_ID'), audience);

  stdout.write(buildSurveyCsv(rows, surveyFor(audience)?.questions ?? []));
} catch (err) {
  stderr.write(
    `export-csv: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  // An exit code rather than `exit(1)`, so stderr drains before the process ends.
  process.exitCode = 1;
} finally {
  await pool.end();
}
