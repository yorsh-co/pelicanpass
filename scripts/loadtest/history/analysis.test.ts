import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  capacities,
  configurations,
  headlines,
  limiterRuns,
} from './analysis.ts';
import { rung } from './rows.fixture.ts';

import type { RungRow } from './row.ts';

/** Raffle climbing to a knee at 14; survey passing all the way to 20. */
const climb: RungRow[] = [
  ...[1, 2, 4, 8, 12, 13, 13].map((scale) => rung({ scale })),
  ...[16, 14, 14].map((scale) => rung({ scale, thresholds_passed: false })),
  ...[1, 2, 4, 8, 16, 20, 20].map((scale) => rung({ phase: 'survey', scale })),
];

describe('capacities', () => {
  it('finds each phase’s capacity and knee, and the users it carries', () => {
    const found = capacities(climb);

    assert.deepEqual(
      found.map(({ phase, capacity, knee, settled, rungs, users }) => ({
        phase,
        capacity,
        knee,
        settled,
        rungs,
        users,
      })),
      [
        {
          phase: 'raffle',
          capacity: 13,
          knee: 14,
          settled: true,
          rungs: 10,
          users: 6500,
        },
        {
          phase: 'survey',
          capacity: 20,
          knee: null,
          settled: true,
          rungs: 7,
          users: 10000,
        },
      ],
    );
  });

  it('uses only valid rungs, on spread addresses, with no overrides', () => {
    const noise = [
      rung({ scale: 1, thresholds_passed: false, valid: false }),
      rung({ scale: 1, thresholds_passed: false, ip_mode: 'single' }),
      rung({ scale: 1, thresholds_passed: false, overrides_set: true }),
      rung({ scale: 1, thresholds_passed: false, load_shed_enabled: true }),
    ];
    const [raffle] = capacities([...climb, ...noise]);

    assert.equal(raffle?.capacity, 13);
    assert.equal(raffle.rungs, 10);
  });

  it('marks a search that has not finished', () => {
    const [raffle] = capacities([
      rung({ scale: 12 }),
      rung({ scale: 16, thresholds_passed: false }),
    ]);

    assert.equal(raffle?.settled, false);
  });

  it('groups commits that leave the app unchanged', () => {
    const docsOnly = climb.map((r) => ({ ...r, commit: 'bbbbbbb2222222' }));
    const found = capacities([...climb, ...docsOnly]);

    assert.equal(found.length, 2);
    assert.deepEqual(found[0]?.commits, ['aaaaaaa1111111', 'bbbbbbb2222222']);
  });

  it('keeps app versions and hosts apart', () => {
    const changed = climb.map((r) => ({ ...r, app_tree: 'uuuuuuu2222222' }));
    const elsewhere = climb.map((r) => ({ ...r, host: 'event-vm' }));

    assert.equal(capacities([...climb, ...changed, ...elsewhere]).length, 6);
  });

  it('has no users for a phase without a population', () => {
    const [redemptions] = capacities([
      rung({ phase: 'redemptions', scale: 1 }),
    ]);

    assert.equal(redemptions?.users, null);
  });
});

describe('headlines', () => {
  it('takes the phase that carries the fewest users', () => {
    assert.deepEqual(
      headlines(capacities(climb)).map(({ phase, users, atLeast }) => ({
        phase,
        users,
        atLeast,
      })),
      [{ phase: 'raffle', users: 6500, atLeast: false }],
    );
  });

  it('marks a lower bound when the limiting phase found no knee', () => {
    const survey = climb.filter((r) => r.phase === 'survey');

    assert.deepEqual(
      headlines(capacities(survey)).map(({ users, atLeast }) => ({
        users,
        atLeast,
      })),
      [{ users: 10000, atLeast: true }],
    );
  });
});

describe('configurations', () => {
  const on = (
    pool: number,
    lag: number,
    scale: number,
    passed: boolean,
    shed: number,
  ) =>
    rung({
      load_shed_enabled: true,
      max_lag_ms: lag,
      max_pool_waiting: pool,
      retry_after_s: 5,
      scale,
      thresholds_passed: passed,
      served_p95: passed ? 400 : 600,
      served_p99: 500,
      shed_rate: shed,
    });

  const tried = [
    on(20, 250, 14, true, 0.3),
    on(20, 250, 16, true, 0.5),
    on(10, 250, 14, true, 0.2),
    on(10, 250, 16, false, 0.6),
    on(20, 125, 14, true, 0.4),
    on(20, 125, 16, true, 0.55),
    // Below the knee: not evidence about serving past it.
    on(10, 250, 12, true, 0),
  ];

  it('ranks configurations meeting the target by the least shed at the knee', () => {
    const results = configurations([...climb, ...tried], capacities(climb));

    assert.deepEqual(
      results.map((r) => ({
        config: `${String(r.maxLagMs)}/${String(r.maxPoolWaiting)}`,
        meets: r.meets,
        scales: r.scales,
        shed: r.atKnee.shed,
        best: r.best,
      })),
      [
        {
          config: '250/20',
          meets: true,
          scales: [14, 16],
          shed: 0.3,
          best: true,
        },
        {
          config: '125/20',
          meets: true,
          scales: [14, 16],
          shed: 0.4,
          best: false,
        },
        {
          config: '250/10',
          meets: false,
          scales: [14, 16],
          shed: 0.2,
          best: false,
        },
      ],
    );
  });

  it('names the closest when none meets the target', () => {
    const missing = [
      on(20, 250, 14, false, 0.3),
      on(10, 250, 14, true, 0.2),
      on(10, 250, 16, false, 0.6),
    ];
    const [first] = configurations([...climb, ...missing], capacities(climb));

    assert.equal(first?.maxPoolWaiting, 10);
    assert.equal(first.meets, false);
    assert.equal(first.best, true);
  });

  it('leaves out a phase with no knee to test past', () => {
    const survey = rung({
      phase: 'survey',
      load_shed_enabled: true,
      scale: 20,
    });

    assert.deepEqual(configurations([...climb, survey], capacities(climb)), []);
  });
});

describe('limiterRuns', () => {
  const single = (changes: Partial<RungRow>) =>
    rung({ ip_mode: 'single', scale: 1, ...changes });

  it('groups by configuration and SCALE, keeping the worst run', () => {
    const found = limiterRuns([
      ...climb,
      single({ thresholds_passed: false, rate_limited_rate: 0.8 }),
      single({ rate_limited_rate: 0, started_at: '2026-09-30T10:00:00Z' }),
      single({ trusted_ips_set: true, rate_limited_rate: 0 }),
      single({ rate_limit_overrides: 'rl:ip:web=300/60', overrides_set: true }),
    ]);

    assert.deepEqual(
      found.map(({ trusted, overrides, runs, passed, refused, lastRun }) => ({
        trusted,
        overrides,
        runs,
        passed,
        refused,
        lastRun,
      })),
      [
        {
          trusted: false,
          overrides: null,
          runs: 2,
          passed: 1,
          refused: 0.8,
          lastRun: '2026-09-30T10:00:00Z',
        },
        {
          trusted: true,
          overrides: null,
          runs: 1,
          passed: 1,
          refused: 0,
          lastRun: null,
        },
        {
          trusted: false,
          overrides: 'rl:ip:web=300/60',
          runs: 1,
          passed: 1,
          refused: null,
          lastRun: null,
        },
      ],
    );
  });

  it('says when a row predates the overrides value', () => {
    const [found] = limiterRuns([single({ overrides_set: true })]);

    assert.equal(found?.overrides, 'set, value not recorded');
  });

  it('keeps a spread rung with changed k6 settings out of capacity and limiters', () => {
    const changed = rung({ scale: 20, k6_env: 'ASSETS=false' });

    assert.deepEqual(limiterRuns([changed]), []);
    assert.deepEqual(capacities([...climb, changed]), capacities(climb));
  });
});
