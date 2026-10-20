import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { k6EnvLabel, parseLadderArgs, participantsFor } from './ladder-args.ts';

const BASE = ['--host', 'dev-server', '--phase', 'raffle'];

describe('parseLadderArgs', () => {
  it('reads a knee search with its defaults', () => {
    assert.deepEqual(parseLadderArgs([...BASE, '--find-knee']), {
      host: 'dev-server',
      phase: 'raffle',
      scales: null,
      ipMode: 'spread',
      maxScale: 20,
      smoke: false,
      build: true,
      appCpuset: null,
      note: null,
      participants: null,
      composeEnv: {},
      k6Env: {},
    });
  });

  it('reads k6 settings for a limiter run', () => {
    const options = parseLadderArgs([
      ...BASE,
      '--scales',
      '1',
      '--ip-mode',
      'cgnat',
      '--k6-env',
      'WIFI_SHARE=0.15',
      '--k6-env',
      'CARRIER_IPS=5',
    ]);

    assert.equal(options.ipMode, 'cgnat');
    assert.deepEqual(options.k6Env, { WIFI_SHARE: '0.15', CARRIER_IPS: '5' });
    assert.equal(k6EnvLabel(options.k6Env), 'CARRIER_IPS=5 WIFI_SHARE=0.15');
    assert.equal(k6EnvLabel({}), null);
  });

  it('reads a config sweep', () => {
    const options = parseLadderArgs([
      ...BASE,
      '--scales',
      '12,16',
      '--env',
      'LOAD_SHED_MAX_POOL_WAITING=10',
      '--env',
      'RATE_LIMIT_OVERRIDES=rl:ip:web=300/60',
      '--app-cpuset',
      '0-7',
      '--note',
      'pool 10',
      '--participants',
      '800',
      '--no-build',
    ]);

    assert.deepEqual(options.scales, [12, 16]);
    assert.deepEqual(options.composeEnv, {
      LOADTEST_LOAD_SHED_MAX_POOL_WAITING: '10',
      LOADTEST_RATE_LIMIT_OVERRIDES: 'rl:ip:web=300/60',
    });
    assert.equal(options.appCpuset, '0-7');
    assert.equal(options.note, 'pool 10');
    assert.equal(options.participants, 800);
    assert.equal(options.build, false);
  });

  it('turns shedding off through the app setting', () => {
    const options = parseLadderArgs([
      ...BASE,
      '--find-knee',
      '--shedding',
      'off',
    ]);

    assert.deepEqual(options.composeEnv, {
      LOADTEST_LOAD_SHED_ENABLED: 'false',
    });
  });

  it('refuses what it cannot run', () => {
    const cases: [string[], RegExp][] = [
      [['--phase', 'raffle', '--find-knee'], /--host is required/],
      [
        ['--host', 'Dev Server PC', '--phase', 'raffle', '--find-knee'],
        /--host is required/,
      ],
      [
        ['--host', 'dev-server', '--phase', 'lunch', '--find-knee'],
        /--phase must be one of/,
      ],
      [BASE, /exactly one of --find-knee and --scales/],
      [[...BASE, '--find-knee', '--scales', '1'], /exactly one of/],
      [
        [...BASE, '--scales', '4,32'],
        /"32" is not a number from above 0 to 20/,
      ],
      [[...BASE, '--scales', '4,x'], /"x" is not a number/],
      [
        [...BASE, '--find-knee', '--env', 'NODE_ENV=development'],
        /--env NODE_ENV=development/,
      ],
      [
        [...BASE, '--find-knee', '--env', 'LOAD_SHED_MAX_LAG_MS'],
        /expected NAME=value/,
      ],
      [
        [...BASE, '--find-knee', '--ip-mode', 'venue'],
        /--ip-mode must be one of/,
      ],
      [
        [...BASE, '--find-knee', '--shedding', 'maybe'],
        /--shedding must be on or off/,
      ],
      [
        [
          ...BASE,
          '--find-knee',
          '--shedding',
          'off',
          '--env',
          'LOAD_SHED_ENABLED=true',
        ],
        /contradicts/,
      ],
      [[...BASE, '--find-knee', '--smoke'], /use it with --scales/],
      [
        [...BASE, '--find-knee', '--participants', '0'],
        /--participants must be a positive whole number/,
      ],
      [
        [...BASE, '--find-knee', '--participants', '10.5'],
        /--participants must be a positive whole number/,
      ],
      [[...BASE, '--find-knee', '--frobnicate'], /Unknown option/],
      [
        [...BASE, '--find-knee', '--k6-env', 'SCALE=4'],
        /--k6-env SCALE=4: expected NAME=value/,
      ],
      [
        [...BASE, '--find-knee', '--k6-env', 'TYPO_RATE=0.1 0.2'],
        /the value must be/,
      ],
    ];

    for (const [argv, error] of cases) {
      assert.throws(() => parseLadderArgs(argv), error, argv.join(' '));
    }
  });
});

describe('participantsFor', () => {
  it('gives survey one participant per arrival', () => {
    assert.equal(participantsFor('survey', 1, null), 520);
    assert.equal(participantsFor('survey', 20, null), 10_400);
    assert.equal(participantsFor('survey', 2.5, null), 1_300);
  });

  it('gives raffle one participant per phone on the front', () => {
    assert.equal(participantsFor('raffle', 1, null), 500);
    assert.equal(participantsFor('raffle', 16, null), 8_000);
    assert.equal(participantsFor('raffle', 2.5, null), 1_250);
  });

  it("gives every other phase the brief's 500", () => {
    assert.equal(participantsFor('redemptions', 16, null), 500);
    assert.equal(participantsFor('checkin-participants', 3, null), 500);
  });

  it('takes an override over either', () => {
    assert.equal(participantsFor('survey', 20, 700), 700);
    assert.equal(participantsFor('raffle', 1, 700), 700);
  });
});
