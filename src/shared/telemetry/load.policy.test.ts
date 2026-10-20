import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INITIAL_LOAD_STATE,
  isLagging,
  isShedExempt,
  nextLoadState,
  SAMPLES_TO_START,
  SAMPLES_TO_STOP,
  shouldShed,
} from './load.policy.ts';

import type { LoadState } from './load.policy.ts';

const BAD = true;
const HEALTHY = false;

/** Feeds judged samples in order and returns every intermediate state. */
const run = (samples: boolean[], from: LoadState = INITIAL_LOAD_STATE) => {
  const states: ReturnType<typeof nextLoadState>[] = [];
  let state = from;

  for (const bad of samples) {
    const next = nextLoadState(state, bad);

    states.push(next);
    state = next;
  }

  return states;
};

const times = (bad: boolean, n: number): boolean[] =>
  Array.from({ length: n }, () => bad);

describe('nextLoadState', () => {
  it('stays off while every sample is healthy', () => {
    const states = run([HEALTHY, HEALTHY, HEALTHY]);

    assert.ok(states.every((s) => !s.overloaded && !s.changed));
  });

  it('does not start on a single bad sample', () => {
    const [first, second] = run([BAD, HEALTHY]);

    assert.equal(first?.overloaded, false);
    assert.equal(second?.overloaded, false);
  });

  it('starts after two consecutive bad samples', () => {
    const [first, second] = run([BAD, BAD]);

    assert.equal(first?.overloaded, false);
    assert.equal(second?.overloaded, true);
    assert.equal(second.changed, true);
  });

  it('holds through one healthy sample', () => {
    const states = run([BAD, BAD, HEALTHY]);

    assert.equal(states.at(-1)?.overloaded, true);
    assert.equal(states.at(-1)?.changed, false);
  });

  it('holds until the stop streak is complete', () => {
    const states = run([
      ...times(BAD, SAMPLES_TO_START),
      ...times(HEALTHY, SAMPLES_TO_STOP - 1),
    ]);

    assert.equal(states.at(-1)?.overloaded, true);
  });

  it('stops after the stop streak of healthy samples', () => {
    const states = run([
      ...times(BAD, SAMPLES_TO_START),
      ...times(HEALTHY, SAMPLES_TO_STOP),
    ]);

    assert.equal(states.at(-1)?.overloaded, false);
    assert.equal(states.at(-1)?.changed, true);
  });

  it('restarts the healthy streak when a bad sample interrupts it', () => {
    const states = run([
      ...times(BAD, SAMPLES_TO_START),
      ...times(HEALTHY, SAMPLES_TO_STOP - 1),
      BAD,
      ...times(HEALTHY, SAMPLES_TO_STOP - 1),
    ]);

    assert.ok(states.slice(SAMPLES_TO_START - 1).every((s) => s.overloaded));
  });

  it('flags a change only on the samples that flip the state', () => {
    const changes = run([
      ...times(BAD, SAMPLES_TO_START + 1),
      ...times(HEALTHY, SAMPLES_TO_STOP + 1),
    ]).map((s) => s.changed);

    const flips = changes.flatMap((changed, i) => (changed ? [i] : []));

    assert.deepEqual(flips, [
      SAMPLES_TO_START - 1,
      SAMPLES_TO_START + SAMPLES_TO_STOP,
    ]);
  });

  it('reports queue shedding as one episode, not one per refusal', () => {
    // Refusals per tick, as the reporting machine sees them: sustained, with
    // the odd quiet tick where the queue dipped under the limit, then quiet.
    const sheds = [
      3,
      2,
      0,
      4,
      1,
      0,
      2,
      ...Array<number>(SAMPLES_TO_STOP).fill(0),
    ];
    const changes = run(sheds.map((n) => n > 0)).map((s) => s.changed);

    assert.equal(changes.filter(Boolean).length, 2);
  });
});

describe('isLagging', () => {
  it('is over the limit only above it', () => {
    assert.equal(isLagging(400, 250), true);
    assert.equal(isLagging(250, 250), false);
    assert.equal(isLagging(5, 250), false);
  });
});

describe('shouldShed', () => {
  it('sheds every request while lag shedding is on', () => {
    assert.equal(shouldShed(true, 0, 20), true);
  });

  it('sheds on the live queue alone', () => {
    assert.equal(shouldShed(false, 21, 20), true);
  });

  it('treats a queue at the limit as healthy', () => {
    assert.equal(shouldShed(false, 20, 20), false);
  });

  it('serves when neither signal is over', () => {
    assert.equal(shouldShed(false, 0, 20), false);
  });
});

describe('isShedExempt', () => {
  it('exempts the admin surface', () => {
    for (const path of [
      '/admin',
      '/admin/',
      '/admin/metrics',
      '/api/v1/admin',
      '/api/v1/admin/metrics',
    ]) {
      assert.equal(isShedExempt(path), true, path);
    }
  });

  it('exempts the admin surface whatever the path case', () => {
    for (const path of ['/ADMIN', '/Admin/metrics', '/api/v1/ADMIN/metrics']) {
      assert.equal(isShedExempt(path), true, path);
    }
  });

  it('does not exempt public routes or lookalikes', () => {
    for (const path of [
      '/',
      '/pass',
      '/checkin',
      '/api/v1/checkin/ticket',
      '/api/v1/staff/redeem',
      '/adminx',
      '/api/v1/administrator',
      '/api/v2/admin',
    ]) {
      assert.equal(isShedExempt(path), false, path);
    }
  });
});
