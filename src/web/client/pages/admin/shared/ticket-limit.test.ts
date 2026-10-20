import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countsTowards,
  resolveTicketLimit,
  wouldRefuse,
} from '../../../../../modules/admin/admin.ticket-limit.rules.ts';
import {
  assumeReached,
  decodeExceeded,
  encodeExceeded,
  excessOf,
  isExceeded,
  meterFill,
  meterNow,
  parseOverview,
  remainingOf,
  wouldBlock,
  wouldCount,
} from './ticket-limit.ts';

import type { TicketLimitOverview } from '../../../../../types/ticket-limit.ts';

const overview = (
  over: Partial<TicketLimitOverview> = {},
): TicketLimitOverview => ({
  scope: 'total',
  cap: 50,
  mode: 'hard',
  used: 50,
  remaining: 0,
  status: 'reached',
  ...over,
});

describe('wouldCount', () => {
  it('agrees with the server rule for every scope, role and code', () => {
    for (const scope of ['off', 'total', 'door'] as const) {
      for (const role of ['participant', 'volunteer'] as const) {
        // Blank stands for a generated code, which the server prefixes `d`.
        for (const [typed, stored] of [
          ['', 'dabc12'],
          ['dabc12', 'dabc12'],
          ['DABC12', 'dabc12'],
          ['xabc12', 'xabc12'],
          ['7abc12', '7abc12'],
        ] as const) {
          assert.equal(
            wouldCount(scope, role, typed),
            countsTowards(scope, role, stored),
            `${scope} ${role} "${typed}"`,
          );
        }
      }
    }
  });
});

describe('wouldBlock', () => {
  it('blocks a counted save at or over a hard cap', () => {
    assert.equal(wouldBlock(overview(), 'participant', ''), true);
    assert.equal(
      wouldBlock(
        overview({ status: 'over', used: 53, remaining: -3 }),
        'participant',
        '',
      ),
      true,
    );
  });

  it('never blocks a volunteer', () => {
    assert.equal(wouldBlock(overview(), 'volunteer', ''), false);
  });

  it('leaves a typed code alone in door scope', () => {
    const door = overview({ scope: 'door' });

    assert.equal(wouldBlock(door, 'participant', ''), true);
    assert.equal(wouldBlock(door, 'participant', 'xabc12'), false);
  });

  it('does not block below the cap, in warn mode, or without a limit', () => {
    assert.equal(
      wouldBlock(
        overview({ status: 'near', used: 47, remaining: 3 }),
        'participant',
        '',
      ),
      false,
    );
    assert.equal(
      wouldBlock(overview({ mode: 'warn' }), 'participant', ''),
      false,
    );
    assert.equal(wouldBlock(null, 'participant', ''), false);
  });

  it('agrees with the server rule', () => {
    for (const used of [0, 44, 45, 49, 50, 51]) {
      for (const mode of ['hard', 'warn'] as const) {
        const resolved = resolveTicketLimit(
          { scope: 'total', cap: 50, mode },
          used,
        );

        assert.equal(
          wouldBlock(resolved, 'participant', ''),
          wouldRefuse(resolved, true),
          `${mode} ${String(used)}`,
        );
      }
    }
  });
});

describe('isExceeded', () => {
  it('is true only for warn mode at reached or over', () => {
    assert.equal(isExceeded(overview({ mode: 'warn' })), true);
    assert.equal(
      isExceeded(overview({ mode: 'warn', status: 'over', used: 51 })),
      true,
    );
    assert.equal(isExceeded(overview({ mode: 'warn', status: 'near' })), false);
    assert.equal(isExceeded(overview()), false);
    assert.equal(isExceeded(null), false);
  });
});

describe('meter figures', () => {
  it('fills in proportion and clamps at full', () => {
    assert.equal(meterFill(overview({ used: 25 })), 0.5);
    assert.equal(meterFill(overview({ used: 53 })), 1);
    assert.equal(meterFill(overview({ cap: null })), 0);
  });

  it('holds the value at the cap and reports the excess and the rest', () => {
    const over = overview({ used: 53, remaining: -3, status: 'over' });

    assert.equal(meterNow(over), 50);
    assert.equal(excessOf(over), 3);
    assert.equal(remainingOf(over), 0);
    assert.equal(remainingOf(overview({ used: 38, remaining: 12 })), 12);
  });
});

describe('parseOverview', () => {
  it('round-trips a valid overview', () => {
    const value = overview({ cap: null, scope: 'off', status: 'off' });

    assert.deepEqual(parseOverview(JSON.stringify(value)), value);
  });

  it('refuses absent, malformed and foreign shapes', () => {
    assert.equal(parseOverview(undefined), null);
    assert.equal(parseOverview('{'), null);
    assert.equal(parseOverview('null'), null);
    assert.equal(parseOverview(JSON.stringify({ scope: 'total' })), null);
    assert.equal(
      parseOverview(JSON.stringify({ ...overview(), status: 'full' })),
      null,
    );
  });
});

describe('exceeded toast key', () => {
  it('round-trips the figures', () => {
    const key = encodeExceeded(
      overview({ mode: 'warn', status: 'over', used: 51, remaining: -1 }),
    );

    assert.equal(key, '51/50');
    assert.deepEqual(decodeExceeded('51/50'), { used: 51, cap: 50 });
  });

  it('encodes nothing when no toast is due', () => {
    assert.equal(encodeExceeded(overview()), null);
    assert.equal(encodeExceeded(null), null);
  });

  it('refuses a suffix that is not ours', () => {
    assert.equal(decodeExceeded('x/50'), null);
    assert.equal(decodeExceeded('51'), null);
  });
});

describe('assumeReached', () => {
  it('takes a limit with room left as reached', () => {
    assert.deepEqual(
      assumeReached(overview({ used: 48, remaining: 2, status: 'near' })),
      overview({ used: 50, remaining: 0, status: 'reached' }),
    );
  });

  it('leaves the figures of a limit already at the cap', () => {
    const reached = overview();

    assert.deepEqual(assumeReached(reached), reached);
  });

  it('keeps an overfull limit over, with the same used', () => {
    const over = overview({ used: 52, remaining: -2, status: 'over' });

    assert.deepEqual(assumeReached(over), over);
  });

  it('leaves an off or uncapped limit unchanged', () => {
    const off = overview({
      scope: 'off',
      cap: null,
      used: 0,
      remaining: null,
      status: 'off',
    });
    const uncapped = overview({ cap: null, remaining: null, status: 'ok' });

    assert.equal(assumeReached(off), off);
    assert.equal(assumeReached(uncapped), uncapped);
  });
});
