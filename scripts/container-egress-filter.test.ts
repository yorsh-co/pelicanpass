import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * Runs `container-egress-filter.sh` against a stand-in `nsenter` that records
 * its arguments and changes nothing, so the rules the script would install can
 * be asserted without touching a firewall.
 */

const SCRIPT = fileURLToPath(
  new URL('./container-egress-filter.sh', import.meta.url),
);

let root: string;
let log: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'egress-filter-'));
  log = join(root, 'calls.log');
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'run', 'dockerd-rootless'), { recursive: true });
  writeFileSync(join(root, 'run', 'dockerd-rootless', 'child_pid'), '1\n');
  writeFileSync(
    join(root, 'bin', 'nsenter'),
    [
      '#!/usr/bin/env bash',
      'echo "$*" >>"$FAKE_LOG"',
      '# A -C (check) finds the rule only when FAKE_RULES_PRESENT is set.',
      '[[ " $* " == *" -C "* ]] && [[ -z "${FAKE_RULES_PRESENT:-}" ]] && exit 1',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(root, 'bin', 'nsenter'), 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Runs the script with the stand-in `nsenter` and returns the recorded calls. */
const run = (action: string, env: Record<string, string> = {}): string[] => {
  const result = spawnSync('bash', [SCRIPT, action], {
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
      XDG_RUNTIME_DIR: join(root, 'run'),
      FAKE_LOG: log,
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(log, 'utf8').trim().split('\n');
};

const INPUT_DROP = '-i %s -m conntrack --ctstate NEW -j DROP';

describe('container-egress-filter.sh INPUT rules', () => {
  it('apply drops new connections from the compose and default bridges', () => {
    const calls = run('apply');

    for (const bridge of ['br-+', 'docker0']) {
      const rule = INPUT_DROP.replace('%s', bridge);
      assert.ok(
        calls.some((c) => c.includes(`iptables -I INPUT 1 ${rule}`)),
        `no INPUT drop for ${bridge}`,
      );
    }
  });

  it('flush removes the INPUT rules that are present', () => {
    const calls = run('flush', { FAKE_RULES_PRESENT: '1' });

    assert.ok(calls.some((c) => c.includes('iptables -D INPUT -i br-+')));
    assert.ok(calls.some((c) => c.includes('iptables -D INPUT -i docker0')));
  });

  it('flush deletes nothing when the rules are absent', () => {
    const calls = run('flush');

    assert.ok(!calls.some((c) => c.includes('-D INPUT')));
  });

  it('apply removes existing INPUT rules before inserting, so it is idempotent', () => {
    const calls = run('apply', { FAKE_RULES_PRESENT: '1' });
    const del = calls.findIndex((c) => c.includes('-D INPUT'));
    const ins = calls.findIndex((c) => c.includes('-I INPUT'));

    assert.ok(del >= 0 && ins > del);
  });
});
