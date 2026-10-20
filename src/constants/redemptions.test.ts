import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REASONS_FOR,
  REDEMPTION_CORRECTIONS,
  REDEMPTION_CORRECTION_REASONS,
  isCorrectionReason,
  isRedemptionCorrection,
  parseRedemptionFilters,
} from './redemptions.ts';

describe('REASONS_FOR', () => {
  it('lists reasons for every correction', () => {
    for (const correction of REDEMPTION_CORRECTIONS) {
      assert.ok(REASONS_FOR[correction].length > 0, correction);
    }
  });

  it('only names reason codes the database admits', () => {
    for (const reasons of Object.values(REASONS_FOR)) {
      for (const reason of reasons) {
        assert.ok(REDEMPTION_CORRECTION_REASONS.includes(reason), reason);
      }
    }
  });

  it('uses every reason code somewhere', () => {
    const used = new Set(Object.values(REASONS_FOR).flat());

    assert.deepEqual(
      [...used].sort(),
      [...REDEMPTION_CORRECTION_REASONS].sort(),
    );
  });
});

describe('isRedemptionCorrection', () => {
  it('accepts both corrections', () => {
    assert.equal(isRedemptionCorrection('mark'), true);
    assert.equal(isRedemptionCorrection('revert'), true);
  });

  it('refuses anything else', () => {
    assert.equal(isRedemptionCorrection('redeem'), false);
    assert.equal(isRedemptionCorrection(undefined), false);
    assert.equal(isRedemptionCorrection(['mark']), false);
  });
});

describe('isCorrectionReason', () => {
  it('accepts a known code', () => {
    assert.equal(isCorrectionReason('mis_tap'), true);
  });

  it('refuses free text and other types', () => {
    assert.equal(isCorrectionReason('misTap'), false);
    assert.equal(isCorrectionReason(''), false);
    assert.equal(isCorrectionReason(1), false);
  });
});

describe('parseRedemptionFilters', () => {
  it('opens on every t-shirt', () => {
    assert.deepEqual(parseRedemptionFilters(undefined), {
      item: 'tshirt',
      status: 'all',
      checkedIn: null,
      q: '',
      page: 1,
    });
  });

  it('reads a full form', () => {
    assert.deepEqual(
      parseRedemptionFilters({
        item: 'meal',
        status: 'redeemed',
        checkin: 'yes',
        q: '  Ana ',
        page: '3',
      }),
      {
        item: 'meal',
        status: 'redeemed',
        checkedIn: true,
        q: 'ana',
        page: 3,
      },
    );
  });

  it('falls back on unknown values', () => {
    const filters = parseRedemptionFilters({
      item: 'hat',
      status: 'lost',
      checkin: 'maybe',
      page: '-2',
    });

    assert.equal(filters.item, 'tshirt');
    assert.equal(filters.status, 'all');
    assert.equal(filters.checkedIn, null);
    assert.equal(filters.page, 1);
  });

  it('falls back on the given status', () => {
    assert.equal(
      parseRedemptionFilters(undefined, 'pending').status,
      'pending',
    );
    assert.equal(
      parseRedemptionFilters({ status: 'lost' }, 'pending').status,
      'pending',
    );
  });

  it('prefers a valid status over the given one', () => {
    assert.equal(
      parseRedemptionFilters({ status: 'all' }, 'pending').status,
      'all',
    );
  });

  it('treats a repeated field as absent', () => {
    assert.equal(
      parseRedemptionFilters({ item: ['meal', 'drink'] }).item,
      'tshirt',
    );
  });
});
