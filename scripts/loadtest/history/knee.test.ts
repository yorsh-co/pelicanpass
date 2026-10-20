import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nextKneeStep } from './knee.ts';

import type { Outcome } from './knee.ts';

/**
 * Runs the search to the end against a stand-in server.
 *
 * @param passes - Whether a rung at `scale` passes; `attempt` counts from 0
 *   per scale, so a flaky boundary can be simulated.
 */
const search = (passes: (scale: number, attempt: number) => boolean) => {
  const outcomes: Outcome[] = [];

  for (let guard = 0; guard < 50; guard++) {
    const step = nextKneeStep(outcomes);

    if (step.done) return { result: step, ran: outcomes.map((o) => o.scale) };

    const attempt = outcomes.filter((o) => o.scale === step.scale).length;

    outcomes.push({ scale: step.scale, passed: passes(step.scale, attempt) });
  }

  throw new Error('search did not finish');
};

describe('nextKneeStep', () => {
  it('starts at 1', () => {
    assert.deepEqual(nextKneeStep([]), { done: false, scale: 1 });
  });

  it('doubles while rungs pass', () => {
    const outcomes = [1, 2, 4].map((scale) => ({ scale, passed: true }));

    assert.deepEqual(nextKneeStep(outcomes), { done: false, scale: 8 });
  });

  it('bisects to the knee and repeats either side of it', () => {
    const { result, ran } = search((scale) => scale <= 13);

    assert.deepEqual(result, {
      done: true,
      capacity: 13,
      knee: 14,
      unstable: false,
    });
    assert.deepEqual(ran, [1, 2, 4, 8, 16, 12, 14, 13, 13, 14]);
  });

  it('finds the knee the first session measured', () => {
    // Raffle on dev-server: 12 passed at 482 ms p95, 16 failed at 3,980 ms.
    const { result } = search((scale) => scale <= 12);

    assert.deepEqual(result, {
      done: true,
      capacity: 12,
      knee: 13,
      unstable: false,
    });
  });

  it('steps to the maximum rather than past it, and reports no knee', () => {
    const { result, ran } = search(() => true);

    assert.deepEqual(result, {
      done: true,
      capacity: 20,
      knee: null,
      unstable: false,
    });
    assert.deepEqual(ran, [1, 2, 4, 8, 16, 20, 20]);
  });

  it('reports the lower capacity when a repeat fails', () => {
    // 13 passes once, then fails on its repeat.
    const { result } = search((scale, attempt) =>
      scale === 13 ? attempt === 0 : scale < 13,
    );

    assert.deepEqual(result, {
      done: true,
      capacity: 12,
      knee: 13,
      unstable: true,
    });
  });

  it('reports a capacity of 0 when the event as briefed fails', () => {
    const { result, ran } = search(() => false);

    assert.deepEqual(result, {
      done: true,
      capacity: 0,
      knee: 1,
      unstable: false,
    });
    assert.deepEqual(ran, [1, 1]);
  });

  it('marks a higher pass above a lower fail as unstable', () => {
    const outcomes = [
      { scale: 8, passed: true },
      { scale: 8, passed: true },
      { scale: 9, passed: false },
      { scale: 9, passed: false },
      { scale: 16, passed: true },
    ];

    assert.deepEqual(nextKneeStep(outcomes), {
      done: true,
      capacity: 8,
      knee: 9,
      unstable: true,
    });
  });

  it('honours a coarser resolution', () => {
    const outcomes = [
      { scale: 8, passed: true },
      { scale: 8, passed: true },
      { scale: 16, passed: false },
      { scale: 16, passed: false },
      { scale: 12, passed: true },
    ];
    const options = { maxScale: 20, resolution: 4, repeats: 2 };

    assert.deepEqual(nextKneeStep(outcomes, options), {
      done: false,
      scale: 12,
    });
  });
});
