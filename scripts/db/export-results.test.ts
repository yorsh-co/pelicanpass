import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { parse } from 'csv-parse/sync';

/**
 * Runs `export-results.sql` against a throwaway Postgres, because nothing else
 * in the repo can execute an SQL script. The container has no network and is
 * removed afterwards. The image must already be cached: the test is skipped,
 * not pulled, where Docker or the image is missing.
 */

const IMAGE =
  'postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const NAME = `export-results-test-${String(process.pid)}`;
const SQL = readFileSync(new URL('./export-results.sql', import.meta.url));

const docker = (args: string[], input?: string): string =>
  execFileSync('docker', args, { encoding: 'utf8', input, stdio: 'pipe' });

const psql = (input: Buffer | string, ...args: string[]): string =>
  docker(
    ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1']
      .concat(args)
      .concat('-q'),
    input.toString(),
  );

const dockerReady = (): boolean => {
  try {
    docker(['image', 'inspect', IMAGE]);
    return true;
  } catch {
    return false;
  }
};

const FORMULA_START = /^[=+\-@\t\r]/;

/** Every prefix the survey export guards, with a tab and a CR among them. */
const PREFIXES = ['=', '+', '-', '@', '\t', '\r'] as const;

const EVENT_ID = 'event-1';

const literal = (value: string): string =>
  `E'${value.replace(/\t/g, '\\t').replace(/\r/g, '\\r')}'`;

describe('export-results.sql', { skip: !dockerReady() }, () => {
  before(async () => {
    docker([
      'run',
      '-d',
      '--rm',
      '--network',
      'none',
      '--name',
      NAME,
      '-e',
      'POSTGRES_PASSWORD=throwaway',
      IMAGE,
    ]);

    for (let attempt = 0; ; attempt += 1) {
      try {
        docker([
          'exec',
          NAME,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'postgres',
        ]);
        break;
      } catch (error) {
        if (attempt > 60) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const rows = PREFIXES.map((prefix, index) => {
      const text = literal(`${prefix}1+1`);

      return `('${EVENT_ID}', 'T${String(index)}', 'participant', false, ${text}, ${text}, ${text}, ${text}, ${text})`;
    });

    psql(`
      CREATE TABLE attendees (
        event_id text NOT NULL,
        ticket_code varchar(7) NOT NULL,
        attendee_role text NOT NULL,
        checkin_complete boolean NOT NULL,
        checkin_number integer,
        checkin_at timestamptz,
        meal_option text,
        meal_redeemed_at timestamptz,
        drink_option text,
        drink_redeemed_at timestamptz,
        tshirt_size text,
        tshirt_redeemed_at timestamptz,
        lunch_option text,
        lunch_redeemed_at timestamptz,
        tshirt_volunteer_size text,
        tshirt_volunteer_redeemed_at timestamptz,
        archived_at timestamptz
      );
      INSERT INTO attendees (
        event_id, ticket_code, attendee_role, checkin_complete,
        meal_option, drink_option, tshirt_size, lunch_option,
        tshirt_volunteer_size
      ) VALUES ${rows.join(',')};
      INSERT INTO attendees (event_id, ticket_code, attendee_role,
        checkin_complete, meal_option)
      VALUES ('${EVENT_ID}', '-ABC12', 'participant', false, 'Burger, "plain"'),
             ('${EVENT_ID}', 'PLAIN01', 'volunteer', false, NULL),
             ('other', '=OTHER1', 'participant', false, '=other');
    `);
  });

  after(() => {
    try {
      docker(['rm', '-f', NAME]);
    } catch {
      // Already gone.
    }
  });

  const exported = (): Record<string, string>[] =>
    parse(psql(SQL, '-v', `event_id=${EVENT_ID}`), {
      columns: true,
      relax_column_count: false,
    });

  it('leaves no text cell starting with a formula character', () => {
    for (const row of exported()) {
      for (const [column, value] of Object.entries(row)) {
        assert.ok(
          !FORMULA_START.test(value),
          `${String(row.ticket_code)} ${column}: ${JSON.stringify(value)}`,
        );
      }
    }
  });

  it('prefixes each text column that starts with each guarded character', () => {
    const rows = exported();

    PREFIXES.forEach((prefix, index) => {
      const row = rows.find(
        (candidate) => candidate.ticket_code === `T${String(index)}`,
      );

      for (const column of [
        'meal_option',
        'drink_option',
        'tshirt_size',
        'lunch_option',
        'tshirt_volunteer_size',
      ]) {
        assert.equal(
          row?.[column],
          `'${prefix}1+1`,
          `${column} ${String(index)}`,
        );
      }
    });
  });

  it('prefixes a ticket code and leaves other cells alone', () => {
    const rows = exported();

    assert.equal(
      rows.find((row) => row.ticket_code === "'-ABC12")?.meal_option,
      'Burger, "plain"',
    );

    const plain = rows.find((row) => row.ticket_code === 'PLAIN01');

    assert.ok(plain);
    assert.equal(plain.meal_option, '');
    assert.equal(plain.attendee_role, 'volunteer');
    assert.equal(rows.length, PREFIXES.length + 2);
  });
});
