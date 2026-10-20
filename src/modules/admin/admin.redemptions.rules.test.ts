import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decideCorrection,
  parseCorrection,
  summaryView,
} from './admin.redemptions.rules.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';

import type { ItemOptions } from './admin.item-options.ts';
import type { SummaryRow } from './admin.redemptions.rules.ts';

const AT = new Date('2026-10-03T18:30:00.123Z');

describe('parseCorrection', () => {
  it('reads a mark', () => {
    assert.deepEqual(parseCorrection('mark', { reason: 'offline' }), {
      reason: 'offline',
      expectedRedeemedAt: null,
    });
  });

  it('reads a revert and its expected timestamp', () => {
    assert.deepEqual(
      parseCorrection('revert', {
        reason: 'mis_tap',
        expectedRedeemedAt: AT.toISOString(),
      }),
      { reason: 'mis_tap', expectedRedeemedAt: AT },
    );
  });

  it('refuses a missing reason', () => {
    assert.throws(
      () => parseCorrection('mark', {}),
      (err) =>
        err instanceof ValidationError &&
        err.details?.reason === 'reasonInvalid',
    );
  });

  it('refuses a reason the correction does not admit', () => {
    assert.throws(
      () => parseCorrection('mark', { reason: 'mis_tap' }),
      (err) =>
        err instanceof ValidationError &&
        err.details?.reason === 'reasonInvalid',
    );

    assert.throws(
      () =>
        parseCorrection('revert', {
          reason: 'offline',
          expectedRedeemedAt: AT.toISOString(),
        }),
      ValidationError,
    );
  });

  it('refuses free text as a reason', () => {
    assert.throws(
      () => parseCorrection('mark', { reason: 'the scanner died' }),
      ValidationError,
    );
  });

  it('refuses a revert without a well-formed timestamp', () => {
    assert.throws(
      () => parseCorrection('revert', { reason: 'mis_tap' }),
      ValidationError,
    );

    assert.throws(
      () =>
        parseCorrection('revert', {
          reason: 'mis_tap',
          expectedRedeemedAt: 'yesterday',
        }),
      ValidationError,
    );
  });

  it('ignores a timestamp sent with a mark', () => {
    assert.equal(
      parseCorrection('mark', {
        reason: 'other',
        expectedRedeemedAt: AT.toISOString(),
      }).expectedRedeemedAt,
      null,
    );
  });
});

describe('decideCorrection', () => {
  const entitled = { archived: false, entitlement: 'G', redeemedAt: null };
  const collected = { ...entitled, redeemedAt: AT };

  it('marks an entitled item not yet collected', () => {
    assert.equal(decideCorrection(entitled, 'mark', null), 'apply');
  });

  it('reverts a collection the screen saw', () => {
    assert.equal(decideCorrection(collected, 'revert', new Date(AT)), 'apply');
  });

  it('refuses any correction on an archived attendee', () => {
    const archived = { ...collected, archived: true };

    assert.equal(decideCorrection(archived, 'revert', AT), 'attendeeArchived');
    assert.equal(
      decideCorrection({ ...entitled, archived: true }, 'mark', null),
      'attendeeArchived',
    );
  });

  it('refuses marking an item nobody registered for', () => {
    // A participant's lunch: the database never lets them hold one.
    assert.equal(
      decideCorrection({ ...entitled, entitlement: null }, 'mark', null),
      'itemNotEntitled',
    );
  });

  it('refuses marking an item already collected', () => {
    assert.equal(
      decideCorrection(collected, 'mark', null),
      'itemAlreadyRedeemed',
    );
  });

  it('refuses reverting an item not collected', () => {
    assert.equal(decideCorrection(entitled, 'revert', AT), 'itemNotRedeemed');
  });

  it('refuses reverting a collection newer than the screen', () => {
    const later = new Date(AT.getTime() + 60_000);

    assert.equal(
      decideCorrection({ ...collected, redeemedAt: later }, 'revert', AT),
      'redemptionChanged',
    );
  });

  it('refuses a revert that carries no expected timestamp', () => {
    assert.equal(
      decideCorrection(collected, 'revert', null),
      'redemptionChanged',
    );
  });
});

describe('summaryView', () => {
  const order: ItemOptions = {
    tshirt: ['P', 'M', 'G'],
    tshirt_volunteer: ['M'],
    lunch: ['Marmita'],
    meal: ['Comum', 'Vegano'],
    drink: ['Suco'],
  };

  const total = (
    item: SummaryRow['item'],
    counts: Omit<SummaryRow, 'item' | 'option' | 'isTotal'>,
  ): SummaryRow => ({ item, option: null, isTotal: true, ...counts });

  const option = (
    item: SummaryRow['item'],
    value: string,
    counts: Omit<SummaryRow, 'item' | 'option' | 'isTotal'>,
  ): SummaryRow => ({ item, option: value, isTotal: false, ...counts });

  const rows: SummaryRow[] = [
    total('tshirt', {
      expected: 10,
      redeemed: 4,
      pendingPresent: 5,
      pendingAbsent: 1,
    }),
    option('tshirt', 'G', {
      expected: 3,
      redeemed: 1,
      pendingPresent: 2,
      pendingAbsent: 0,
    }),
    option('tshirt', 'Extra', {
      expected: 1,
      redeemed: 0,
      pendingPresent: 0,
      pendingAbsent: 1,
    }),
    option('tshirt', 'P', {
      expected: 6,
      redeemed: 3,
      pendingPresent: 3,
      pendingAbsent: 0,
    }),
  ];

  it('lists every item in screen order, even with nobody entitled', () => {
    assert.deepEqual(
      summaryView(rows, order).map((entry) => entry.item),
      ['tshirt_volunteer', 'lunch', 'tshirt', 'meal', 'drink'],
    );
  });

  it('reports no share, rather than NaN, when nothing is expected', () => {
    const lunch = summaryView(rows, order).find((e) => e.item === 'lunch');

    assert.deepEqual(lunch, {
      item: 'lunch',
      expected: 0,
      redeemed: 0,
      pendingPresent: 0,
      pendingAbsent: 0,
      share: null,
      options: [],
    });
  });

  it('computes the share of collections', () => {
    const tshirt = summaryView(rows, order).find((e) => e.item === 'tshirt');

    assert.equal(tshirt?.share, 0.4);
  });

  it('orders options as the approved list does, off-list values last', () => {
    const tshirt = summaryView(rows, order).find((e) => e.item === 'tshirt');

    assert.deepEqual(
      tshirt?.options.map((entry) => entry.option),
      ['P', 'G', 'Extra'],
    );
  });

  it('keeps the option rows summing to the item total', () => {
    const tshirt = summaryView(rows, order).find((e) => e.item === 'tshirt');

    assert.ok(tshirt);

    for (const key of [
      'expected',
      'redeemed',
      'pendingPresent',
      'pendingAbsent',
    ] as const) {
      assert.equal(
        tshirt.options.reduce((sum, entry) => sum + entry[key], 0),
        tshirt[key],
        key,
      );
    }
  });
});
