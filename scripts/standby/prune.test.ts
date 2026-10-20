import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * Runs `prune_old` from `lib.sh`, which `restore.sh` and `cutback.sh` call
 * after writing a `pre-restore-*.dump` or `cutback-*.tar` into `~/standby`.
 */

const LIB = fileURLToPath(new URL('./lib.sh', import.meta.url));

const STAMPS = [
  '20261001T100000Z',
  '20261002T100000Z',
  '20261003T100000Z',
  '20261004T100000Z',
  '20261005T100000Z',
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'standby-prune-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Calls `prune_old DIR PATTERN KEEP KEEP_FILE` in a fresh bash. */
const prune = (pattern: string, keepFile: string, keep = 3) =>
  spawnSync(
    'bash',
    [
      '-c',
      'source "$1" && prune_old "$2" "$3" "$4" "$5"',
      'bash',
      LIB,
      dir,
      pattern,
      String(keep),
      keepFile,
    ],
    { encoding: 'utf8' },
  );

const touch = (...names: string[]): void => {
  names.forEach((name) => {
    writeFileSync(join(dir, name), 'x');
  });
};

/** Returns `names[index]`, failing the test if the fixture is too short. */
const pick = (names: string[], index: number): string => {
  const name = names[index];
  assert.ok(name, `fixture has no entry ${String(index)}`);
  return name;
};

describe('prune_old', () => {
  it('keeps the newest three of five dated files and logs the rest', () => {
    const names = STAMPS.map((s) => `pre-restore-${s}.dump`);
    touch(...names);

    const result = prune('pre-restore-*.dump', join(dir, pick(names, 4)));

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(dir).sort(), names.slice(2));
    assert.match(result.stdout, /pre-restore-20261001T100000Z\.dump/);
    assert.match(result.stdout, /pre-restore-20261002T100000Z\.dump/);
  });

  it('never deletes the file just written, even when it sorts oldest', () => {
    const names = STAMPS.map((s) => `cutback-${s}.tar`);
    touch(...names);

    prune('cutback-*.tar', join(dir, pick(names, 0)));

    assert.ok(existsSync(join(dir, pick(names, 0))));
  });

  it('protects the file just written when it is named by a relative path', () => {
    const names = STAMPS.map((s) => `cutback-${s}.tar`);
    touch(...names);

    const result = spawnSync(
      'bash',
      [
        '-c',
        'source "$1" && prune_old "$2" "$3" 3 "$4"',
        'bash',
        LIB,
        dir,
        'cutback-*.tar',
        `./${pick(names, 0)}`,
      ],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(dir, pick(names, 0))));
  });

  it('leaves other kinds of file, directories and symlinks alone', () => {
    const dumps = STAMPS.map((s) => `pre-restore-${s}.dump`);
    touch(...dumps, 'cutback-20261001T100000Z.tar', 'notes.txt');
    writeFileSync(join(dir, 'target'), 'x');
    symlinkSync(
      join(dir, 'target'),
      join(dir, 'pre-restore-20260101T000000Z.dump'),
    );

    prune('pre-restore-*.dump', join(dir, pick(dumps, 4)));

    const left = readdirSync(dir);
    assert.ok(left.includes('cutback-20261001T100000Z.tar'));
    assert.ok(left.includes('notes.txt'));
    assert.ok(left.includes('target'));
    assert.ok(left.includes('pre-restore-20260101T000000Z.dump'));
    assert.equal(left.filter((n) => n.endsWith('.dump')).length, 4);
  });

  it('handles a directory whose path contains spaces', () => {
    const spaced = join(dir, 'my standby');
    const names = STAMPS.map((s) => `cutback-${s}.tar`);
    spawnSync('mkdir', [spaced]);
    names.forEach((n) => {
      writeFileSync(join(spaced, n), 'x');
    });

    const result = spawnSync(
      'bash',
      [
        '-c',
        'source "$1" && prune_old "$2" "$3" 3 "$4"',
        'bash',
        LIB,
        spaced,
        'cutback-*.tar',
        join(spaced, pick(names, 4)),
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readdirSync(spaced).length, 3);
  });

  it('removes nothing when three or fewer match', () => {
    const names = STAMPS.slice(0, 3).map((s) => `cutback-${s}.tar`);
    touch(...names);

    const result = prune('cutback-*.tar', join(dir, pick(names, 2)));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readdirSync(dir).length, 3);
  });
});
