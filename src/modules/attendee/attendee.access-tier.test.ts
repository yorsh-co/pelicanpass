import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accessTier } from './attendee.access-tier.ts';

import type { AccessTierInput } from './attendee.access-tier.ts';

const EDIT = ['attendees:read', 'attendees:write'];
const LOOKUP = ['attendees:read', 'checkin:write'];
const TSHIRT = ['tshirt:redeem'];

/** A volunteer holding nothing and linked to no administrator. */
const volunteer = (
  overrides: Partial<AccessTierInput> = {},
): AccessTierInput => ({
  attendeeRole: 'volunteer',
  canRedeem: false,
  redeemScopes: [],
  canDraw: false,
  adminScopes: null,
  ...overrides,
});

/** A volunteer who may redeem at the lunch station. */
const redeemer = (overrides: Partial<AccessTierInput> = {}): AccessTierInput =>
  volunteer({ canRedeem: true, redeemScopes: ['lunch'], ...overrides });

describe('accessTier', () => {
  it('gives a volunteer holding nothing none', () => {
    assert.equal(accessTier(volunteer()), 'none');
  });

  it('gives edit for attendees:read with attendees:write', () => {
    assert.equal(accessTier(volunteer({ adminScopes: EDIT })), 'edit');
  });

  it('gives raffle for can_draw', () => {
    assert.equal(accessTier(volunteer({ canDraw: true })), 'raffle');
  });

  it('gives lookup for attendees:read with checkin:write', () => {
    assert.equal(accessTier(volunteer({ adminScopes: LOOKUP })), 'lookup');
  });

  it('gives redeem for can_redeem with a valid station', () => {
    assert.equal(accessTier(redeemer()), 'redeem');
  });

  it('gives a participant no tier whatever they hold', () => {
    assert.equal(
      accessTier({
        attendeeRole: 'participant',
        canRedeem: true,
        redeemScopes: ['lunch'],
        canDraw: true,
        adminScopes: [...EDIT, ...LOOKUP, ...TSHIRT],
      }),
      null,
    );
  });

  it('does not count can_redeem with no stations', () => {
    assert.equal(accessTier(volunteer({ canRedeem: true })), 'none');
  });

  it('does not count can_redeem with only unknown stations', () => {
    assert.equal(
      accessTier(volunteer({ canRedeem: true, redeemScopes: ['pizza', ''] })),
      'none',
    );
  });

  it('does not count stations without can_redeem', () => {
    assert.equal(accessTier(volunteer({ redeemScopes: ['lunch'] })), 'none');
  });

  it('does not count a valid station next to unknown ones against it', () => {
    assert.equal(
      accessTier(redeemer({ redeemScopes: ['pizza', 'drink'] })),
      'redeem',
    );
  });

  it('does not treat checkin:write alone as lookup', () => {
    assert.equal(
      accessTier(volunteer({ adminScopes: ['checkin:write'] })),
      'none',
    );
  });

  it('does not treat attendees:read alone as lookup', () => {
    assert.equal(
      accessTier(volunteer({ adminScopes: ['attendees:read'] })),
      'none',
    );
  });

  it('does not treat attendees:write without attendees:read as edit', () => {
    assert.equal(
      accessTier(volunteer({ adminScopes: ['attendees:write'] })),
      'none',
    );
    assert.equal(
      accessTier(
        volunteer({ adminScopes: ['attendees:write', 'checkin:write'] }),
      ),
      'none',
    );
  });

  it('gives tshirt for tshirt:redeem', () => {
    assert.equal(accessTier(volunteer({ adminScopes: TSHIRT })), 'tshirt');
  });

  it('does not give tshirt without a linked administrator', () => {
    assert.equal(accessTier(volunteer({ adminScopes: null })), 'none');
    assert.equal(accessTier(volunteer({ adminScopes: [] })), 'none');
  });

  it('ranks lookup above tshirt', () => {
    assert.equal(
      accessTier(volunteer({ adminScopes: [...LOOKUP, ...TSHIRT] })),
      'lookup',
    );
  });

  it('ranks edit above tshirt', () => {
    assert.equal(
      accessTier(volunteer({ adminScopes: [...EDIT, ...TSHIRT] })),
      'edit',
    );
  });

  it('ranks tshirt above redeem', () => {
    assert.equal(accessTier(redeemer({ adminScopes: TSHIRT })), 'tshirt');
  });

  it('ranks tshirt above raffle', () => {
    assert.equal(
      accessTier(volunteer({ canDraw: true, adminScopes: TSHIRT })),
      'tshirt',
    );
  });

  it('ranks lookup above redeem', () => {
    assert.equal(accessTier(redeemer({ adminScopes: LOOKUP })), 'lookup');
  });

  it('ranks redeem above raffle', () => {
    assert.equal(accessTier(redeemer({ canDraw: true })), 'redeem');
  });

  it('ranks lookup above raffle', () => {
    assert.equal(
      accessTier(volunteer({ canDraw: true, adminScopes: LOOKUP })),
      'lookup',
    );
    assert.equal(
      accessTier(redeemer({ canDraw: true, adminScopes: LOOKUP })),
      'lookup',
    );
  });

  it('ranks edit above everything', () => {
    assert.equal(
      accessTier(
        redeemer({ canDraw: true, adminScopes: [...EDIT, ...LOOKUP] }),
      ),
      'edit',
    );
  });

  it('treats an empty scope set like no linked administrator', () => {
    assert.equal(accessTier(redeemer({ adminScopes: [] })), 'redeem');
    assert.equal(accessTier(redeemer({ adminScopes: null })), 'redeem');
  });

  it('ignores unknown admin scopes', () => {
    assert.equal(
      accessTier(volunteer({ adminScopes: ['bogus', 'attendees:read'] })),
      'none',
    );
    assert.equal(
      accessTier(
        volunteer({
          adminScopes: ['bogus', 'attendees:read', 'checkin:write'],
        }),
      ),
      'lookup',
    );
  });

  it('applies the precedence over every combination of capabilities', () => {
    const flags = [false, true];

    for (const edit of flags)
      for (const draw of flags)
        for (const redeem of flags)
          for (const lookup of flags)
            for (const tshirt of flags) {
              const adminScopes = [
                ...(edit ? EDIT : []),
                ...(lookup ? ['attendees:read', 'checkin:write'] : []),
                ...(tshirt ? TSHIRT : []),
              ];

              const expected = edit
                ? 'edit'
                : lookup
                  ? 'lookup'
                  : tshirt
                    ? 'tshirt'
                    : redeem
                      ? 'redeem'
                      : draw
                        ? 'raffle'
                        : 'none';

              assert.equal(
                accessTier(
                  volunteer({
                    canDraw: draw,
                    canRedeem: redeem,
                    redeemScopes: redeem ? ['meal'] : [],
                    adminScopes,
                  }),
                ),
                expected,
                JSON.stringify({ edit, draw, redeem, lookup, tshirt }),
              );
            }
  });
});
