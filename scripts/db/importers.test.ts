import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

/**
 * Runs the two operator importers as the operator does, with the file on
 * stdin. Every case here is refused while the file is read, before a
 * connection is opened, so the unreachable database below is never touched.
 */

const ROSTER = new URL('./import-attendees.ts', import.meta.url).pathname;
const PERMISSIONS = new URL('./set-volunteer-permissions.ts', import.meta.url)
  .pathname;

const ROSTER_HEADER = 'ticket_code,name,phone,role,meal_option,team';

/** Result of one importer run. */
interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs an importer against a database that cannot be reached.
 *
 * @param script - Importer to run.
 * @param input - File contents for stdin.
 * @param args - Command-line switches.
 */
const run = (script: string, input: string, ...args: string[]): Run => {
  const result = spawnSync(process.execPath, [script, ...args], {
    input,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      EVENT_ID: 'event-1',
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: '1',
      POSTGRES_DB: 'unreachable',
      POSTGRES_MIGRATOR_USER: 'nobody',
      POSTGRES_MIGRATOR_PASSWORD: 'nothing',
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

describe('roster importer, formula cells', () => {
  const file = `${ROSTER_HEADER}\nxabc12,Ana Lima,+55 (11) 90000-1234,,,\nvabc13,Bruno Maia,5511900002222,volunteer,=cmd|x,\n`;

  for (const args of [[], ['--dry-run']]) {
    const mode = args.length === 0 ? 'a real run' : '--dry-run';

    it(`refuses the row with its line and column in ${mode}`, () => {
      const { status, stdout, stderr } = run(ROSTER, file, ...args);

      assert.equal(status, 1);
      assert.match(stdout, /line 3 \(vabc13\): meal_option /);
      assert.match(stderr, /Nothing imported: 1 problem\(s\)/);
    });
  }
});

describe('permissions importer, formula cells', () => {
  it('refuses the row with its line and column, and in --dry-run alike', () => {
    const file = 'ticket_code,can_redeem\nvabc12,true\n=vabc13,true\n';

    for (const args of [[], ['--dry-run']]) {
      const { status, stdout, stderr } = run(PERMISSIONS, file, ...args);

      assert.equal(status, 1);
      assert.match(stdout, /line 3: ticket_code /);
      assert.match(stderr, /Nothing written: 1 problem/);
    }
  });
});

describe('importer input limits', () => {
  const ROW = 'xabc12,Ana Lima,5511900001234';

  /** Both importers, with a file the limits must refuse before parsing. */
  const refused = (input: string, message: RegExp): void => {
    for (const script of [ROSTER, PERMISSIONS]) {
      const { status, stdout, stderr } = run(script, input, '--dry-run');

      assert.equal(status, 1);
      assert.match(stderr, message);
      assert.equal(stdout, '');
    }
  };

  it('refuses input over 2 MB', () => {
    refused('a'.repeat(2 * 1024 * 1024 + 1), /larger than 2 MB/);
  });

  it('refuses more than 5,000 data rows', () => {
    refused(
      `ticket_code,name,phone\n${`${ROW}\n`.repeat(5001)}`,
      /5,001 data rows/,
    );
  });

  it('refuses a NUL byte with its line, not stripping it', () => {
    refused(
      `ticket_code,name,phone\n${ROW}\nxabc13,Bia\0,5511900001235\n`,
      /line 3: .*NUL/,
    );
  });

  it('lets a BOM file past the limits to the parser', () => {
    const { stdout } = run(
      ROSTER,
      `\uFEFFticket_code,name,phone,team\nvabc12,Ana Lima,5511900001234,=x\n`,
      '--dry-run',
    );

    assert.match(stdout, /line 2 \(vabc12\): team /);
  });
});
