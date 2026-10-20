import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COLUMNS } from './row.ts';
import { judge } from './validity.ts';

import type { RungRow } from './row.ts';

const EMPTY = Object.fromEntries(COLUMNS.map((c) => [c, null])) as RungRow;

/** A clean, passing rung, with the given columns changed. */
const rung = (changes: Partial<RungRow> = {}) => ({
  ...EMPTY,
  k6_exit: 0,
  thresholds_passed: true,
  dropped_rate: 0.002,
  other_load_p95: 0.3,
  throttle_ms: 0,
  ...changes,
});

describe('judge', () => {
  it('accepts a clean rung', () => {
    assert.deepEqual(judge(rung()), { valid: true, invalid_reason: null });
  });

  it('accepts a rung that failed only its thresholds', () => {
    assert.equal(
      judge(rung({ k6_exit: 99, thresholds_passed: false })).valid,
      true,
    );
  });

  it('rejects a rung k6 did not finish', () => {
    assert.deepEqual(judge(rung({ k6_exit: 107 })), {
      valid: false,
      invalid_reason: 'k6 exited 107',
    });
  });

  it('rejects a busy host', () => {
    assert.deepEqual(judge(rung({ other_load_p95: 2.46 })), {
      valid: false,
      invalid_reason: 'host busy (2.5 cores of other load)',
    });
  });

  it('rejects a throttled host', () => {
    assert.deepEqual(judge(rung({ throttle_ms: 4200 })), {
      valid: false,
      invalid_reason: 'host throttled (4200 ms)',
    });
  });

  it('rejects a pass that dropped arrivals', () => {
    assert.deepEqual(judge(rung({ dropped_rate: 0.094 })), {
      valid: false,
      invalid_reason: 'dropped 9.4% of arrivals',
    });
  });

  it('keeps a fail that dropped arrivals: it failed on less load', () => {
    const verdict = judge(
      rung({ k6_exit: 99, thresholds_passed: false, dropped_rate: 0.094 }),
    );

    assert.equal(verdict.valid, true);
  });

  it('does not hold empty columns against a rung', () => {
    assert.equal(judge(EMPTY).valid, true);
  });

  it('gives every reason at once', () => {
    assert.equal(
      judge(rung({ k6_exit: 1, throttle_ms: 2000 })).invalid_reason,
      'k6 exited 1; host throttled (2000 ms)',
    );
  });

  it('applies the limits it is given', () => {
    const limits = {
      otherLoadCores: 0.1,
      throttleMs: 1_000,
      droppedRate: 0.01,
    };

    assert.equal(judge(rung(), limits).valid, false);
  });
});
