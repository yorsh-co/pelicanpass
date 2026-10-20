import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * Runs `snapshot_max_bytes`, `receive_capped` and `check_snapshot_members`
 * from `lib.sh`, which bound what `pull.sh`, `restore.sh` and `cutback.sh`
 * accept from the primary. Tars are built with the system `tar`, in the member
 * order `snapshot.sh` writes.
 */

const LIB = fileURLToPath(new URL('./lib.sh', import.meta.url));

const MEMBERS = ['meta', 'db.dump', 'cache.rdb'];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'standby-check-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs a bash snippet with `lib.sh` sourced and `$@` set to `args`. */
const lib = (snippet: string, args: string[], input?: Buffer | string) =>
  spawnSync(
    'bash',
    ['-c', `source "$1" && shift && ${snippet}`, 'bash', LIB, ...args],
    { encoding: 'utf8', input, env: { PATH: process.env.PATH ?? '' } },
  );

/** Builds `name` in the temp dir from `members`; each is a file of that many bytes. */
const buildTar = (
  name: string,
  members: Record<string, number> = {
    meta: 10,
    'db.dump': 10,
    'cache.rdb': 10,
  },
  extra: string[] = [],
): string => {
  const src = mkdtempSync(join(dir, 'src-'));
  Object.entries(members).forEach(([member, size]) => {
    writeFileSync(join(src, member), 'x'.repeat(size));
  });
  const names = [...Object.keys(members), ...extra];
  const tar = join(dir, name);
  const result = spawnSync('tar', ['-C', src, '-cf', tar, ...names], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return tar;
};

const check = (tar: string, max: number) =>
  lib('check_snapshot_members "$1" "$2"', [tar, String(max)]);

describe('snapshot_max_bytes', () => {
  it('defaults to 256 MiB', () => {
    const result = lib('snapshot_max_bytes', []);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, String(256 * 1024 * 1024));
  });

  it('honours STANDBY_MAX_SNAPSHOT_BYTES set after lib.sh is sourced', () => {
    const result = lib(
      'STANDBY_MAX_SNAPSHOT_BYTES=4096; snapshot_max_bytes',
      [],
    );

    assert.equal(result.stdout, '4096');
  });

  for (const bad of ['0', '-5', '10MB', '1.5', '']) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      const result = lib('STANDBY_MAX_SNAPSHOT_BYTES="$1" snapshot_max_bytes', [
        bad,
      ]);

      // An empty value falls back to the default, like any unset variable.
      if (bad === '') {
        assert.equal(result.status, 0, result.stderr);
        return;
      }
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /STANDBY_MAX_SNAPSHOT_BYTES/);
    });
  }
});

describe('receive_capped', () => {
  const receive = (input: Buffer, max: number) => {
    const dest = join(dir, 'incoming');
    const result = lib('receive_capped "$1" "$2"', [String(max), dest], input);
    return { result, dest };
  };

  it('keeps a stream under the limit intact', () => {
    const input = Buffer.from('hello snapshot');

    const { result, dest } = receive(input, 100);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(dest), input);
  });

  it('keeps a stream exactly at the limit', () => {
    const input = Buffer.alloc(64, 'a');

    const { result, dest } = receive(input, 64);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(dest), input);
  });

  it('refuses a stream one byte over the limit and never holds more', () => {
    const { result, dest } = receive(Buffer.alloc(65, 'a'), 64);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /larger than 64 bytes/);
    assert.ok(statSync(dest).size <= 65);
  });

  it('stops reading a far larger stream at max + 1 bytes', () => {
    const { result, dest } = receive(Buffer.alloc(1_000_000, 'a'), 64);

    assert.equal(result.status, 1);
    assert.equal(statSync(dest).size, 65);
  });

  it('fails the pipeline when the producer fails, under pipefail', () => {
    const dest = join(dir, 'incoming');
    const result = lib(
      'set -o pipefail; { printf abc; exit 3; } | receive_capped 100 "$1"',
      [dest],
    );

    assert.notEqual(result.status, 0);
  });
});

describe('check_snapshot_members', () => {
  it('passes a valid snapshot', () => {
    const result = check(buildTar('ok.tar'), 1_000_000);

    assert.equal(result.status, 0, result.stderr);
  });

  it('refuses a tar larger than the limit', () => {
    const tar = buildTar('big.tar');

    const result = check(tar, statSync(tar).size - 1);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /larger than/);
  });

  /** A tar of sparse files: small on disk, with large member sizes in its listing. */
  const sparseTar = (sizes: Record<string, number>): string => {
    const src = mkdtempSync(join(dir, 'sparse-'));
    Object.entries(sizes).forEach(([member, size]) => {
      writeFileSync(join(src, member), '');
      truncateSync(join(src, member), size);
    });
    const tar = join(dir, 'sparse.tar');
    const result = spawnSync('tar', ['-C', src, '-S', '-cf', tar, ...MEMBERS], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return tar;
  };

  it('refuses a member larger than the limit although the tar is small', () => {
    const tar = sparseTar({ meta: 10, 'db.dump': 8_000_000, 'cache.rdb': 10 });
    assert.ok(statSync(tar).size < 100_000);

    const result = check(tar, 1_000_000);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /members total/);
  });

  it('refuses members that are each under the limit but total over it', () => {
    const tar = sparseTar({
      meta: 10,
      'db.dump': 600_000,
      'cache.rdb': 600_000,
    });

    const result = check(tar, 1_000_000);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /members total/);
  });

  it('accepts members that total exactly the limit', () => {
    const tar = sparseTar({ meta: 100, 'db.dump': 10_000, 'cache.rdb': 9900 });

    const result = check(tar, 20_000);

    assert.equal(result.status, 0, result.stderr);
  });

  it('refuses a symlink in place of a member', () => {
    const src = join(dir, 'link-src');
    mkdirSync(src);
    writeFileSync(join(src, 'meta'), 'x');
    writeFileSync(join(src, 'cache.rdb'), 'x');
    symlinkSync('/etc/passwd', join(src, 'db.dump'));
    const tar = join(dir, 'link.tar');
    spawnSync('tar', ['-C', src, '-cf', tar, ...MEMBERS]);

    const result = check(tar, 1_000_000);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a regular file/);
  });

  it('refuses a hardlink in place of a member', () => {
    const src = join(dir, 'hard-src');
    mkdirSync(src);
    writeFileSync(join(src, 'meta'), 'x');
    writeFileSync(join(src, 'cache.rdb'), 'x');
    spawnSync('ln', [join(src, 'meta'), join(src, 'db.dump')]);
    const tar = join(dir, 'hard.tar');
    spawnSync('tar', ['-C', src, '-cf', tar, ...MEMBERS]);

    const result = check(tar, 1_000_000);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a regular file/);
  });

  it('refuses a directory in place of a member', () => {
    const src = join(dir, 'dir-src');
    mkdirSync(join(src, 'cache.rdb'), { recursive: true });
    writeFileSync(join(src, 'meta'), 'x');
    writeFileSync(join(src, 'db.dump'), 'x');
    const tar = join(dir, 'dir.tar');
    spawnSync('tar', ['-C', src, '-cf', tar, ...MEMBERS]);

    const result = check(tar, 1_000_000);

    assert.equal(result.status, 1);
  });

  it('refuses an extra member', () => {
    const tar = buildTar('extra.tar', {
      meta: 1,
      'db.dump': 1,
      'cache.rdb': 1,
      'evil.sh': 1,
    });

    const result = check(tar, 1_000_000);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unexpected member/);
  });

  it('refuses a missing member', () => {
    const tar = buildTar('missing.tar', { meta: 1, 'db.dump': 1 });

    const result = check(tar, 1_000_000);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /members/);
  });

  it('refuses a file that is not a tar', () => {
    const file = join(dir, 'junk.tar');
    writeFileSync(file, 'not a tar archive at all');

    const result = check(file, 1_000_000);

    assert.equal(result.status, 1);
    assert.ok(existsSync(file));
  });
});
