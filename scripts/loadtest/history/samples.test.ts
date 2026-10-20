import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  otherLoad,
  parseDockerStats,
  parseLoadavg,
  parsePgActive,
  parseProcPidStat,
  parseProcStat,
  percentile,
  shedStarts,
  summarizeSamples,
  topOther,
} from './samples.ts';

import type { ProcReading, ProcSnapshot, SampleSet } from './samples.ts';

const PROJECT = 'pelicanpass-loadtest';

const APP_ID = 'a'.repeat(64);
const SYNC_ID = 'b'.repeat(64);
const K6_ID = 'c'.repeat(64);

const stats = (id: string, name: string, cpu: string) =>
  JSON.stringify({
    Container: id,
    Name: name,
    CPUPerc: cpu,
    MemUsage: '1MiB / 1GiB',
  });

describe('parseDockerStats', () => {
  it('reads each container, past the escape codes docker writes between frames', () => {
    const text = [
      `\u001b[2J\u001b[H${stats(APP_ID, `${PROJECT}-app`, '107.25%')}`,
      stats('dece37c2a08e', `${PROJECT}-db`, '0.02%'),
    ].join('\n');

    assert.deepEqual(parseDockerStats(text, 5), [
      { t: 5, id: APP_ID, name: `${PROJECT}-app`, cpu: 107.25 },
      { t: 5, id: null, name: `${PROJECT}-db`, cpu: 0.02 },
    ]);
  });

  it('skips lines it cannot use', () => {
    const text = [
      '',
      '{"Name": "half a li',
      JSON.stringify({ Name: 'no-cpu' }),
      stats(APP_ID, 'bad-cpu', '--'),
      '[1, 2]',
    ].join('\n');

    assert.deepEqual(parseDockerStats(text, 0), []);
  });
});

describe('parseProcStat', () => {
  it('splits the aggregate line into busy and total', () => {
    const text = 'cpu  100 10 50 800 40 5 5 0 0 0\ncpu0 1 2 3 4 5 6 7 8 9 10\n';

    assert.deepEqual(parseProcStat(text, 1), { t: 1, busy: 170, total: 1010 });
  });

  it('gives nothing without an aggregate line', () => {
    assert.equal(parseProcStat('cpu0 1 2 3 4 5 6 7 8\n', 1), null);
    assert.equal(parseProcStat('cpu  1 2 x\n', 1), null);
  });
});

describe('parseLoadavg', () => {
  it('reads the one-minute figure', () => {
    assert.equal(parseLoadavg('1.67 1.17 1.25 2/2117 1676948\n'), 1.67);
    assert.equal(parseLoadavg(''), null);
  });
});

describe('parsePgActive', () => {
  it('sums active backends across wait types', () => {
    assert.equal(parsePgActive('active||3\nidle|Client|5\nactive|Lock|2\n'), 5);
    assert.equal(parsePgActive(''), 0);
  });
});

describe('percentile', () => {
  it('takes the nearest rank', () => {
    const values = Array.from({ length: 20 }, (_, i) => 20 - i);

    assert.equal(percentile(values, 95), 19);
    assert.equal(percentile(values, 100), 20);
    assert.equal(percentile([7], 95), 7);
    assert.equal(percentile([], 95), null);
  });
});

describe('shedStarts', () => {
  it('counts start lines only, not the alert that quotes one', () => {
    const lines = [
      JSON.stringify({
        msg: 'Load shedding started',
        lagMs: 22,
        poolWaiting: 42,
      }),
      JSON.stringify({
        msg: 'Load shedding stopped',
        lagMs: 1,
        poolWaiting: 0,
      }),
      JSON.stringify({
        msg: 'Load shedding started',
        lagMs: 47,
        poolWaiting: 30,
      }),
      JSON.stringify({
        msg: 'Alert suppressed: alerting disabled',
        alert: { title: 'Load shedding started' },
      }),
      'not json',
    ];

    assert.deepEqual(shedStarts(lines), {
      shed_starts: 2,
      pool_waiting_at_start_max: 42,
      lag_at_start_max: 47,
    });
  });

  it('leaves the maxima empty when nothing was shed', () => {
    assert.deepEqual(shedStarts([]), {
      shed_starts: 0,
      pool_waiting_at_start_max: null,
      lag_at_start_max: null,
    });
  });
});

describe('parseProcPidStat', () => {
  it('reads the fields that follow the command name', () => {
    const text =
      '1234 (Web Content) S 1000 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 30 0 987654 123456 7890\n';

    assert.deepEqual(parseProcPidStat(text), {
      pid: 1234,
      ppid: 1000,
      start: 987654,
      comm: 'Web Content',
      ticks: 300,
    });
  });

  it('counts from the last parenthesis of a name that holds some', () => {
    const text = '7 ((a) b)) R 1 7 7 0 -1 0 0 0 0 0 3 4 0 0 20 0 1 0 55 1 1\n';

    assert.deepEqual(parseProcPidStat(text), {
      pid: 7,
      ppid: 1,
      start: 55,
      comm: '(a) b)',
      ticks: 7,
    });
  });

  it('gives nothing for text it cannot read', () => {
    assert.equal(parseProcPidStat(''), null);
    assert.equal(parseProcPidStat('9 (short) S 1'), null);
  });
});

const USER = '0::/user.slice/user-1000.slice/user@1000.service';

const proc = (
  pid: number,
  comm: string,
  cgroup: string,
  ticks: number,
  ppid = 1,
  start = pid,
): ProcReading => ({ pid, ppid, start, comm, ticks, cgroup });

/**
 * One second on a four-core host. Every process starts at zero ticks except
 * `make`, which is not in the first snapshot at all.
 */
const snapshots = (): ProcSnapshot[] => {
  const after: ProcReading[] = [
    proc(10, 'helium', `${USER}/app.slice/app-helium.service`, 50),
    proc(11, 'zed-editor', `${USER}/app.slice/app-dev.zed.Zed.service`, 20),
    proc(20, 'MainThread', `${USER}/user.slice/docker-${APP_ID}.scope`, 100),
    proc(21, 'syncthing', `${USER}/user.slice/docker-${SYNC_ID}.scope`, 10),
    proc(22, 'k6', `${USER}/user.slice/docker-${K6_ID}.scope`, 80),
    proc(30, 'dockerd', `${USER}/app.slice/docker.service`, 40),
    proc(500, 'node', `${USER}/app.slice/app-konsole.service`, 30),
    proc(501, 'docker', `${USER}/app.slice/app-konsole.service`, 10, 500),
    proc(
      502,
      'docker-compose',
      `${USER}/app.slice/app-konsole.service`,
      5,
      501,
    ),
    proc(40, 'make', `${USER}/app.slice/app-konsole.service`, 15),
  ];
  const before = after
    .filter((p) => p.comm !== 'make')
    .map((p) => ({ ...p, ticks: 0 }));

  return [
    { t: 0, procs: before },
    { t: 1000, procs: after },
  ];
};

const names = new Map([
  [APP_ID, `${PROJECT}-app`],
  [SYNC_ID, 'syncthing'],
]);

describe('otherLoad', () => {
  const { series, seconds } = otherLoad(snapshots(), {
    project: PROJECT,
    runnerPid: 500,
    clkTck: 100,
    names,
  });

  it('counts the desktop, other projects and new processes, in cores', () => {
    // helium 0.5 + zed 0.2 + syncthing 0.1 + make 0.15. Left out: the app,
    // a k6 container docker stats has not named yet, dockerd, and the runner
    // with its children.
    assert.equal(series.length, 1);
    assert.ok(Math.abs((series[0]?.cores ?? 0) - 0.95) < 1e-9);
  });

  it('keeps each command’s CPU seconds', () => {
    assert.deepEqual(
      [...seconds].sort(([a], [b]) => a.localeCompare(b)),
      [
        ['helium', 0.5],
        ['make', 0.15],
        ['syncthing', 0.1],
        ['zed-editor', 0.2],
      ],
    );
  });

  it('treats a reused PID as a new process', () => {
    const [before, after] = snapshots();
    const reused: ProcSnapshot[] = [
      before ?? { t: 0, procs: [] },
      {
        t: 1000,
        procs: (after?.procs ?? []).map((p) =>
          p.comm === 'helium' ? { ...p, start: 999, ticks: 5 } : p,
        ),
      },
    ];
    const result = otherLoad(reused, {
      project: PROJECT,
      runnerPid: 500,
      clkTck: 100,
      names,
    });

    // helium's new process ran 0.05 s since it began, not 0.5.
    assert.ok(Math.abs((result.series[0]?.cores ?? 0) - 0.5) < 1e-9);
  });
});

describe('topOther', () => {
  it('names up to three commands of at least 0.05 cores', () => {
    const seconds = new Map([
      ['helium', 50],
      ['zed-editor', 20],
      ['syncthing', 10],
      ['make', 15],
      ['kwin', 4],
    ]);

    assert.equal(
      topOther(seconds, 100),
      'helium 0.50, zed-editor 0.20, make 0.15',
    );
  });

  it('names nothing on a quiet host', () => {
    assert.equal(topOther(new Map([['kwin', 1]]), 100), null);
    assert.equal(topOther(new Map(), 0), null);
  });
});

describe('summarizeSamples', () => {
  const samples: SampleSet = {
    containers: [
      { t: 0, id: APP_ID, name: `${PROJECT}-app`, cpu: 80 },
      { t: 0, id: null, name: `${PROJECT}-db`, cpu: 20 },
      { t: 900, id: APP_ID, name: `${PROJECT}-app`, cpu: 100 },
      { t: 900, id: null, name: `${PROJECT}-db`, cpu: 50 },
      { t: 900, id: K6_ID, name: `${PROJECT}-k6-run-1a2b`, cpu: 30 },
      { t: 900, id: SYNC_ID, name: 'syncthing', cpu: 10 },
      { t: 5000, id: APP_ID, name: `${PROJECT}-app`, cpu: 120 },
    ],
    // Half the host busy, then a quarter.
    host: [
      { t: 0, busy: 0, total: 0 },
      { t: 1000, busy: 200, total: 400 },
      { t: 2000, busy: 300, total: 800 },
    ],
    procs: snapshots(),
    load1: [0.5, 2.25, 1],
    pgActive: [1, 4, 2],
    throttleMs: { start: 1000, end: 1250 },
    appLog: [],
  };

  const result = summarizeSamples(samples, {
    project: PROJECT,
    runnerPid: 500,
    clkTck: 100,
  });

  it('reports stack containers, matched by project', () => {
    assert.equal(result.app_cpu_peak, 120);
    assert.equal(result.app_cpu_p95, 120);
    assert.equal(result.db_cpu_peak, 50);
    assert.equal(result.k6_cpu_peak, 30);
  });

  it('reports host CPU and other load, naming what caused it', () => {
    // Once the k6 container is named, its process belongs to the stack.
    assert.equal(result.host_cpu_peak, 50);
    assert.ok(Math.abs((result.other_load_p95 ?? 0) - 0.95) < 1e-9);
    assert.equal(result.other_top, 'helium 0.50, zed-editor 0.20, make 0.15');
  });

  it('reports throttling, load, and the database', () => {
    assert.equal(result.throttle_ms, 250);
    assert.equal(result.load1_peak, 2.25);
    assert.equal(result.pg_active_peak, 4);
  });

  it('leaves what was not sampled empty', () => {
    const empty = summarizeSamples(
      {
        containers: [],
        host: [],
        procs: [],
        load1: [],
        pgActive: [],
        throttleMs: null,
        appLog: [],
      },
      { project: PROJECT, runnerPid: 500, clkTck: 100 },
    );

    assert.equal(empty.app_cpu_peak, null);
    assert.equal(empty.other_load_p95, null);
    assert.equal(empty.other_top, null);
    assert.equal(empty.throttle_ms, null);
    assert.equal(empty.shed_starts, 0);
  });
});
