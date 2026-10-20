import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_RATE_LIMITS, resolveRateLimits } from './rate-limits.ts';

describe('resolveRateLimits', () => {
  it('returns the defaults when there are no overrides', () => {
    for (const raw of ['', '   ', ',', ' , ']) {
      const { limits, overridden } = resolveRateLimits(raw);

      assert.deepEqual(limits, DEFAULT_RATE_LIMITS, JSON.stringify(raw));
      assert.deepEqual(overridden, []);
    }
  });

  it('applies a single override', () => {
    const { limits, overridden } = resolveRateLimits('rl:ip=600/60');

    assert.deepEqual(limits['rl:ip'], { points: 600, duration: 60 });
    assert.deepEqual(overridden, ['rl:ip']);
    assert.deepEqual(limits['rl:ip:web'], DEFAULT_RATE_LIMITS['rl:ip:web']);
  });

  it('applies several overrides, tolerating whitespace', () => {
    const { limits, overridden } = resolveRateLimits(
      ' rl:ip = 600/60 ,rl:ip:web:trusted=2000/120, readyz=50/10 ',
    );

    assert.deepEqual(limits['rl:ip'], { points: 600, duration: 60 });
    assert.deepEqual(limits['rl:ip:web:trusted'], {
      points: 2000,
      duration: 120,
    });
    assert.deepEqual(limits.readyz, { points: 50, duration: 10 });
    assert.deepEqual(overridden, ['rl:ip', 'rl:ip:web:trusted', 'readyz']);
  });

  it('keeps the default blockDuration of an overridden limiter', () => {
    const { limits } = resolveRateLimits('rl:admin:login-failures=20/600');

    assert.deepEqual(limits['rl:admin:login-failures'], {
      points: 20,
      duration: 600,
      blockDuration: 900,
    });
  });

  it('does not mutate the defaults', () => {
    const before = structuredClone(DEFAULT_RATE_LIMITS);

    resolveRateLimits('rl:ip=1/1,rl:admin:login-failures=1/1');

    assert.deepEqual(DEFAULT_RATE_LIMITS, before);
  });

  it('returns a frozen result', () => {
    const { limits } = resolveRateLimits('rl:ip=600/60');

    assert.ok(Object.isFrozen(limits));
  });

  it('rejects an unknown prefix, naming the valid ones', () => {
    assert.throws(
      () => resolveRateLimits('rl:nope=1/60'),
      /"rl:nope", which is not a rate limiter\. Valid prefixes: .*rl:ip,/,
    );
  });

  it('rejects inherited object keys as prefixes', () => {
    assert.throws(
      () => resolveRateLimits('toString=1/60'),
      /not a rate limiter/,
    );
  });

  it('rejects malformed entries', () => {
    for (const raw of [
      'rl:ip',
      'rl:ip=600',
      'rl:ip=abc/60',
      'rl:ip=1.5/60',
      'rl:ip=-1/60',
      'rl:ip=600/60/1',
      'rl:ip 600/60',
      '=600/60',
    ]) {
      assert.throws(
        () => resolveRateLimits(raw),
        /must be "prefix=points\/duration"/,
        raw,
      );
    }
  });

  it('rejects zero points or duration', () => {
    for (const raw of ['rl:ip=0/60', 'rl:ip=600/0']) {
      assert.throws(
        () => resolveRateLimits(raw),
        /must both be at least 1/,
        raw,
      );
    }
  });

  it('rejects a prefix named twice', () => {
    assert.throws(
      () => resolveRateLimits('rl:ip=600/60,rl:ip=700/60'),
      /"rl:ip" more than once/,
    );
  });
});
