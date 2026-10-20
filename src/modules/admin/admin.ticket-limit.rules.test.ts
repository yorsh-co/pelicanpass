import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  countsTowards,
  readTicketLimitInput,
  resolveTicketLimit,
  wouldRefuse,
} from './admin.ticket-limit.rules.ts';
import {
  TICKET_LIMIT_CAP_MAX,
  TICKET_LIMIT_CAP_MIN,
} from '../../constants/ticket-limit.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';

import type {
  TicketLimitMode,
  TicketLimitOverview,
  TicketLimitScope,
  TicketLimitStatus,
} from '../../types/ticket-limit.ts';

const refusedAs = (reason: string) => (err: unknown) =>
  err instanceof ValidationError &&
  err.statusCode === 400 &&
  err.details?.reason === reason;

const resolve = (
  scope: TicketLimitScope,
  cap: number | null,
  used: number,
  mode: TicketLimitMode = 'hard',
): TicketLimitOverview => resolveTicketLimit({ scope, cap, mode }, used);

describe('countsTowards', () => {
  const GENERATED = 'dabc12';
  const BARE = 'xabc12';
  const OTHER_SOURCE = '7abc12';
  const VOLUNTEER = 'vabc12';

  it('counts nothing when the limit is off', () => {
    for (const code of [GENERATED, BARE, OTHER_SOURCE, VOLUNTEER]) {
      assert.equal(countsTowards('off', 'participant', code), false);
      assert.equal(countsTowards('off', 'volunteer', code), false);
    }
  });

  it('counts every participant in total scope', () => {
    for (const code of [GENERATED, BARE, OTHER_SOURCE]) {
      assert.equal(countsTowards('total', 'participant', code), true);
    }
  });

  it('counts only generated participant codes in door scope', () => {
    assert.equal(countsTowards('door', 'participant', GENERATED), true);
  });

  it('ignores typed bare and other-source codes in door scope', () => {
    assert.equal(countsTowards('door', 'participant', BARE), false);
    assert.equal(countsTowards('door', 'participant', OTHER_SOURCE), false);
  });

  it('never counts a volunteer, in any scope', () => {
    for (const scope of ['off', 'total', 'door'] as const) {
      assert.equal(countsTowards(scope, 'volunteer', VOLUNTEER), false);
    }
  });

  it('never counts a volunteer even when the code looks generated', () => {
    assert.equal(countsTowards('total', 'volunteer', GENERATED), false);
    assert.equal(countsTowards('door', 'volunteer', GENERATED), false);
  });
});

describe('resolveTicketLimit', () => {
  const statusAt = (cap: number, used: number): TicketLimitStatus =>
    resolve('total', cap, used).status;

  it('is ok below 90% of a cap of 100', () => {
    assert.equal(statusAt(100, 0), 'ok');
    assert.equal(statusAt(100, 89), 'ok');
  });

  it('is near from 90% up to the cap', () => {
    assert.equal(statusAt(100, 90), 'near');
    assert.equal(statusAt(100, 99), 'near');
  });

  it('is reached at the cap and over above it', () => {
    assert.equal(statusAt(100, 100), 'reached');
    assert.equal(statusAt(100, 101), 'over');
  });

  it('applies the thresholds at small caps', () => {
    assert.equal(statusAt(1, 0), 'ok');
    assert.equal(statusAt(1, 1), 'reached');
    assert.equal(statusAt(1, 2), 'over');
    assert.equal(statusAt(10, 8), 'ok');
    assert.equal(statusAt(10, 9), 'near');
  });

  it('reports remaining as cap minus used, negative when over', () => {
    assert.equal(resolve('total', 100, 40).remaining, 60);
    assert.equal(resolve('total', 100, 100).remaining, 0);
    assert.equal(resolve('total', 100, 105).remaining, -5);
  });

  it('echoes the setting and the count', () => {
    assert.deepEqual(resolve('door', 50, 10, 'warn'), {
      scope: 'door',
      cap: 50,
      mode: 'warn',
      used: 10,
      remaining: 40,
      status: 'ok',
    });
  });

  it('is off, with defaults, when no row exists', () => {
    assert.deepEqual(resolveTicketLimit(null, 7), {
      scope: 'off',
      cap: null,
      mode: 'hard',
      used: 7,
      remaining: null,
      status: 'off',
    });
  });

  it('is off but keeps the stored cap and mode for an off row', () => {
    assert.deepEqual(resolve('off', 80, 95, 'warn'), {
      scope: 'off',
      cap: 80,
      mode: 'warn',
      used: 95,
      remaining: null,
      status: 'off',
    });
  });

  it('is off for an off row that never held a cap', () => {
    const overview = resolve('off', null, 3);

    assert.equal(overview.status, 'off');
    assert.equal(overview.cap, null);
    assert.equal(overview.remaining, null);
  });
});

describe('wouldRefuse', () => {
  const cases: {
    mode: TicketLimitMode;
    used: number;
    counted: boolean;
    refuse: boolean;
  }[] = [
    { mode: 'hard', used: 9, counted: true, refuse: false },
    { mode: 'hard', used: 10, counted: true, refuse: true },
    { mode: 'hard', used: 11, counted: true, refuse: true },
    { mode: 'hard', used: 9, counted: false, refuse: false },
    { mode: 'hard', used: 10, counted: false, refuse: false },
    { mode: 'hard', used: 11, counted: false, refuse: false },
    { mode: 'warn', used: 9, counted: true, refuse: false },
    { mode: 'warn', used: 10, counted: true, refuse: false },
    { mode: 'warn', used: 11, counted: true, refuse: false },
    { mode: 'warn', used: 10, counted: false, refuse: false },
  ];

  for (const { mode, used, counted, refuse } of cases) {
    it(`${refuse ? 'refuses' : 'allows'} ${mode} at ${String(used)}/10, ${counted ? 'counted' : 'not counted'}`, () => {
      assert.equal(
        wouldRefuse(resolve('total', 10, used, mode), counted),
        refuse,
      );
    });
  }

  it('never refuses when the limit is off', () => {
    assert.equal(wouldRefuse(resolve('off', 10, 50), true), false);
    assert.equal(wouldRefuse(resolveTicketLimit(null, 50), true), false);
  });
});

describe('readTicketLimitInput', () => {
  it('accepts a valid total and door setting', () => {
    assert.deepEqual(
      readTicketLimitInput({ scope: 'total', cap: 250, mode: 'hard' }),
      { scope: 'total', cap: 250, mode: 'hard' },
    );
    assert.deepEqual(
      readTicketLimitInput({ scope: 'door', cap: 40, mode: 'warn' }),
      { scope: 'door', cap: 40, mode: 'warn' },
    );
  });

  it('accepts the cap bounds', () => {
    for (const cap of [TICKET_LIMIT_CAP_MIN, TICKET_LIMIT_CAP_MAX]) {
      assert.equal(
        readTicketLimitInput({ scope: 'total', cap, mode: 'hard' }).cap,
        cap,
      );
    }
  });

  it('accepts an off setting with a null or kept cap', () => {
    assert.deepEqual(
      readTicketLimitInput({ scope: 'off', cap: null, mode: 'hard' }),
      { scope: 'off', cap: null, mode: 'hard' },
    );
    assert.deepEqual(
      readTicketLimitInput({ scope: 'off', cap: 120, mode: 'warn' }),
      { scope: 'off', cap: 120, mode: 'warn' },
    );
  });

  it('rejects an unknown or missing scope', () => {
    for (const scope of ['everyone', 'TOTAL', '', 1, null, undefined]) {
      assert.throws(
        () => readTicketLimitInput({ scope, cap: 10, mode: 'hard' }),
        refusedAs('ticketLimitScope'),
      );
    }
  });

  it('rejects a cap that is not an integer in range', () => {
    const invalid = [
      0,
      -1,
      TICKET_LIMIT_CAP_MAX + 1,
      1.5,
      Number.NaN,
      Infinity,
      '10',
      true,
      null,
      undefined,
    ];

    for (const cap of invalid) {
      assert.throws(
        () => readTicketLimitInput({ scope: 'total', cap, mode: 'hard' }),
        refusedAs('ticketLimitCap'),
        `total with cap ${String(cap)}`,
      );
    }
  });

  it('rejects an off setting whose cap is neither null nor valid', () => {
    for (const cap of [0, 100_001, 2.5, '10', undefined]) {
      assert.throws(
        () => readTicketLimitInput({ scope: 'off', cap, mode: 'hard' }),
        refusedAs('ticketLimitCap'),
        `off with cap ${String(cap)}`,
      );
    }
  });

  it('rejects an unknown or missing mode', () => {
    for (const mode of ['soft', 'HARD', '', 0, null, undefined]) {
      assert.throws(
        () => readTicketLimitInput({ scope: 'total', cap: 10, mode }),
        refusedAs('ticketLimitMode'),
      );
    }
  });

  it('rejects a body that is not an object', () => {
    for (const body of [undefined, null, 'total', 42, []]) {
      assert.throws(
        () => readTicketLimitInput(body),
        refusedAs('ticketLimitScope'),
      );
    }
  });

  it('reports the scope first, then the cap, then the mode', () => {
    assert.throws(
      () => readTicketLimitInput({ scope: 'x', cap: 0, mode: 'x' }),
      refusedAs('ticketLimitScope'),
    );
    assert.throws(
      () => readTicketLimitInput({ scope: 'total', cap: 0, mode: 'x' }),
      refusedAs('ticketLimitCap'),
    );
  });
});
