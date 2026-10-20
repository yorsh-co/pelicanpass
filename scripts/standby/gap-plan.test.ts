import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REDEMPTION_ITEMS,
  planGap,
  type Gap,
  type GapCheckin,
  type GapRedemption,
  type Standby,
  type StandbyAttendee,
} from './gap-plan.ts';

const TAKEN_AT = '2026-10-09T18:00:00Z';

const gapOf = (over: Partial<Gap> = {}): Gap => ({
  takenAt: TAKEN_AT,
  checkins: [],
  redemptions: [],
  items: [],
  created: [],
  edited: [],
  ...over,
});

const standbyOf = (over: Partial<Standby> = {}): Standby => ({
  numberFloor: 1100,
  attendees: [],
  heldNumbers: [],
  ownActivity: [],
  replayedIds: [],
  drawsSinceTakenAt: 0,
  ...over,
});

/** Attendee id is derived from the code so builders agree by default. */
const idOf = (code: string): string => `id-${code}`;

const checkin = (code: string, over: Partial<GapCheckin> = {}): GapCheckin => ({
  ticketCode: code,
  attendeeId: idOf(code),
  role: 'participant',
  checkinNumber: 1050,
  checkinAt: '2026-10-09T19:00:00Z',
  ...over,
});

const redemption = (
  id: string,
  code: string,
  over: Partial<GapRedemption> = {},
): GapRedemption => ({
  redemptionId: id,
  ticketCode: code,
  attendeeId: idOf(code),
  item: 'meal',
  outcome: 'redeemed',
  redeemedBy: 'vol-1',
  actorType: 'volunteer',
  reason: null,
  createdAt: '2026-10-09T19:30:00Z',
  ...over,
});

const attendee = (
  code: string,
  over: Partial<StandbyAttendee> = {},
): StandbyAttendee => ({
  attendeeId: idOf(code),
  ticketCode: code,
  role: 'participant',
  archived: false,
  checkinComplete: false,
  checkinNumber: null,
  checkinAt: null,
  redeemedAt: Object.fromEntries(
    REDEMPTION_ITEMS.map((item) => [item, null]),
  ) as StandbyAttendee['redeemedAt'],
  ...over,
});

const withItem = (
  code: string,
  item: (typeof REDEMPTION_ITEMS)[number],
  redeemedAt: string | null,
  over: Partial<StandbyAttendee> = {},
): StandbyAttendee => {
  const base = attendee(code, over);

  return { ...base, redeemedAt: { ...base.redeemedAt, [item]: redeemedAt } };
};

const own = (
  id: string,
  code: string,
  outcome: string,
  over: { item?: GapRedemption['item']; createdAt?: string } = {},
) => ({
  redemptionId: id,
  ticketCode: code,
  item: over.item ?? ('meal' as const),
  outcome,
  createdAt: over.createdAt ?? '2026-10-09T19:40:00Z',
});

const noticeOf = (plan: ReturnType<typeof planGap>, start: string) =>
  plan.notices.find((n) => n.heading.startsWith(start));

describe('planGap', () => {
  it('plans nothing for an empty gap', () => {
    const plan = planGap(gapOf(), standbyOf());

    assert.deepEqual(plan, {
      checkins: [],
      redemptionInserts: [],
      itemUpdates: [],
      unchanged: { checkins: 0, items: 0 },
      problems: [],
      notices: [],
    });
  });

  describe('problems', () => {
    it('refuses a ticket created on prod-server after the snapshot', () => {
      const plan = planGap(
        gapOf({ created: ['T9'], checkins: [checkin('T9')] }),
        standbyOf(),
      );

      assert.deepEqual(plan.problems, [
        'T9: created on prod-server after the snapshot — add it in the attendees editor on dev-server, then run again',
      ]);
    });

    it('refuses a check-in for a ticket missing on dev-server', () => {
      const plan = planGap(gapOf({ checkins: [checkin('T1')] }), standbyOf());

      assert.deepEqual(plan.problems, ['T1: not found on dev-server']);
      assert.deepEqual(plan.checkins, []);
    });

    it('refuses a redemption for a ticket missing on dev-server', () => {
      const plan = planGap(
        gapOf({
          redemptions: [redemption('r1', 'T1')],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: null }],
        }),
        standbyOf(),
      );

      assert.deepEqual(plan.problems, ['T1: not found on dev-server']);
    });

    it('reports a ticket missing for both a check-in and a redemption once', () => {
      const plan = planGap(
        gapOf({
          checkins: [checkin('T1')],
          redemptions: [redemption('r1', 'T1')],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: null }],
        }),
        standbyOf(),
      );

      assert.equal(plan.problems.length, 1);
    });

    it('refuses a ticket held by a different attendee id', () => {
      const plan = planGap(
        gapOf({ checkins: [checkin('T1')] }),
        standbyOf({
          attendees: [attendee('T1', { attendeeId: 'someone-else' })],
        }),
      );

      assert.deepEqual(plan.problems, [
        'T1: a different attendee holds this code on dev-server',
      ]);
    });

    it('refuses a participant check-in without a number', () => {
      const plan = planGap(
        gapOf({ checkins: [checkin('T1', { checkinNumber: null })] }),
        standbyOf({ attendees: [attendee('T1')] }),
      );

      assert.equal(plan.problems.length, 1);
      assert.match(plan.problems[0] ?? '', /^T1: .*no number/);
    });

    it('refuses a number above the reserve', () => {
      const plan = planGap(
        gapOf({ checkins: [checkin('T1', { checkinNumber: 1101 })] }),
        standbyOf({ attendees: [attendee('T1')] }),
      );

      assert.match(plan.problems[0] ?? '', /^T1: .*1101.*above the reserve/);
    });

    it('accepts a number equal to the floor', () => {
      const plan = planGap(
        gapOf({ checkins: [checkin('T1', { checkinNumber: 1100 })] }),
        standbyOf({ attendees: [attendee('T1')] }),
      );

      assert.deepEqual(plan.problems, []);
      assert.equal(plan.checkins.length, 1);
    });

    it('refuses a number held by a different ticket on dev-server', () => {
      const plan = planGap(
        gapOf({ checkins: [checkin('T1')] }),
        standbyOf({
          attendees: [attendee('T1')],
          heldNumbers: [{ checkinNumber: 1050, ticketCode: 'T2' }],
        }),
      );

      assert.match(plan.problems[0] ?? '', /^T1: .*1050.*another ticket/);
    });

    it('refuses a role mismatch', () => {
      const plan = planGap(
        gapOf({ checkins: [checkin('T1')] }),
        standbyOf({ attendees: [attendee('T1', { role: 'volunteer' })] }),
      );

      assert.equal(
        plan.problems[0],
        'T1: role is participant on prod-server but volunteer on dev-server',
      );
    });

    it('refuses an item with no prod-server state in the export', () => {
      const plan = planGap(
        gapOf({ redemptions: [redemption('r1', 'T1')] }),
        standbyOf({ attendees: [attendee('T1')] }),
      );

      assert.equal(
        plan.problems[0],
        'T1 meal: prod-server item state missing from the export',
      );
    });

    it('never puts anything but codes and items in a message', () => {
      const plan = planGap(
        gapOf({ created: ['T3'], checkins: [checkin('T1')] }),
        standbyOf(),
      );

      for (const problem of plan.problems) {
        assert.match(problem, /^T\d/);
      }
    });

    it('sorts problems by ticket code', () => {
      const plan = planGap(
        gapOf({ checkins: [checkin('T2'), checkin('T1')], created: ['T0'] }),
        standbyOf(),
      );

      assert.deepEqual(
        plan.problems.map((p) => p.slice(0, 2)),
        ['T0', 'T1', 'T2'],
      );
    });
  });

  describe('check-ins', () => {
    it('writes a participant check-in with prod-server number and time', () => {
      const plan = planGap(
        gapOf({ checkins: [checkin('T1')] }),
        standbyOf({ attendees: [attendee('T1')] }),
      );

      assert.deepEqual(plan.checkins, [
        {
          attendeeId: idOf('T1'),
          ticketCode: 'T1',
          checkinNumber: 1050,
          checkinAt: '2026-10-09T19:00:00Z',
        },
      ]);
    });

    it('writes a volunteer check-in with a null number', () => {
      const plan = planGap(
        gapOf({
          checkins: [checkin('V1', { role: 'volunteer', checkinNumber: null })],
        }),
        standbyOf({ attendees: [attendee('V1', { role: 'volunteer' })] }),
      );

      assert.deepEqual(plan.problems, []);
      assert.equal(plan.checkins[0]?.checkinNumber, null);
    });

    it('counts a participant already checked in with the same number', () => {
      const plan = planGap(
        gapOf({ checkins: [checkin('T1')] }),
        standbyOf({
          attendees: [
            attendee('T1', { checkinComplete: true, checkinNumber: 1050 }),
          ],
          heldNumbers: [{ checkinNumber: 1050, ticketCode: 'T1' }],
        }),
      );

      assert.deepEqual(plan.checkins, []);
      assert.equal(plan.unchanged.checkins, 1);
      assert.deepEqual(plan.notices, []);
    });

    it('counts a volunteer already checked in at the same instant', () => {
      const plan = planGap(
        gapOf({
          checkins: [
            checkin('V1', {
              role: 'volunteer',
              checkinNumber: null,
              checkinAt: '2026-10-09T19:51:17Z',
            }),
          ],
        }),
        standbyOf({
          attendees: [
            attendee('V1', {
              role: 'volunteer',
              checkinComplete: true,
              checkinAt: '2026-10-09T19:51:17.000+00:00',
            }),
          ],
        }),
      );

      assert.equal(plan.unchanged.checkins, 1);
      assert.deepEqual(plan.notices, []);
    });

    it('keeps the dev-server number when a participant checked in again there', () => {
      const plan = planGap(
        gapOf({ checkins: [checkin('T1')] }),
        standbyOf({
          attendees: [
            attendee('T1', { checkinComplete: true, checkinNumber: 1120 }),
          ],
        }),
      );

      assert.deepEqual(plan.checkins, []);
      assert.equal(plan.unchanged.checkins, 0);
      assert.deepEqual(
        noticeOf(plan, 'Checked in again on dev-server')?.lines,
        ['T1: dev-server #1120, prod-server #1050 not used'],
      );
    });

    it('keeps a volunteer checked in again at another time', () => {
      const plan = planGap(
        gapOf({
          checkins: [checkin('V1', { role: 'volunteer', checkinNumber: null })],
        }),
        standbyOf({
          attendees: [
            attendee('V1', {
              role: 'volunteer',
              checkinComplete: true,
              checkinAt: '2026-10-09T20:00:00Z',
            }),
          ],
        }),
      );

      assert.deepEqual(plan.checkins, []);
      assert.match(
        noticeOf(plan, 'Checked in again on dev-server')?.lines[0] ?? '',
        /^V1: volunteer, no numbers/,
      );
    });

    it('skips an archived attendee and says so', () => {
      const plan = planGap(
        gapOf({ checkins: [checkin('T1')] }),
        standbyOf({ attendees: [attendee('T1', { archived: true })] }),
      );

      assert.deepEqual(plan.checkins, []);
      assert.deepEqual(
        noticeOf(plan, 'Archived on dev-server — not checked in'),
        {
          heading: 'Archived on dev-server — not checked in',
          lines: ['T1'],
        },
      );
    });

    it('orders check-ins by time, then ticket code', () => {
      const plan = planGap(
        gapOf({
          checkins: [
            checkin('T3', {
              checkinNumber: 1052,
              checkinAt: '2026-10-09T19:02:00Z',
            }),
            checkin('T2', {
              checkinNumber: 1051,
              checkinAt: '2026-10-09T19:01:00Z',
            }),
            checkin('T1', {
              checkinNumber: 1050,
              checkinAt: '2026-10-09T19:01:00Z',
            }),
          ],
        }),
        standbyOf({
          attendees: [attendee('T1'), attendee('T2'), attendee('T3')],
        }),
      );

      assert.deepEqual(
        plan.checkins.map((c) => c.ticketCode),
        ['T1', 'T2', 'T3'],
      );
    });
  });

  describe('redemptions', () => {
    const redeemed = '2026-10-09T19:30:00Z';

    it('inserts gap rows dev-server does not hold, in gap order', () => {
      const rows = [
        redemption('r2', 'T2'),
        redemption('r1', 'T1'),
        redemption('r3', 'T1'),
      ];
      const plan = planGap(
        gapOf({
          redemptions: rows,
          items: [
            { ticketCode: 'T1', item: 'meal', redeemedAt: redeemed },
            { ticketCode: 'T2', item: 'meal', redeemedAt: redeemed },
          ],
        }),
        standbyOf({
          attendees: [attendee('T1'), attendee('T2')],
          replayedIds: ['r1'],
        }),
      );

      assert.deepEqual(
        plan.redemptionInserts.map((r) => r.redemptionId),
        ['r2', 'r3'],
      );
      assert.equal(plan.redemptionInserts[0], rows[0]);
    });

    it('updates item state when dev-server has no activity of its own', () => {
      const plan = planGap(
        gapOf({
          redemptions: [redemption('r1', 'T1')],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: redeemed }],
        }),
        standbyOf({ attendees: [attendee('T1')] }),
      );

      assert.deepEqual(plan.itemUpdates, [
        {
          attendeeId: idOf('T1'),
          ticketCode: 'T1',
          item: 'meal',
          redeemedAt: redeemed,
        },
      ]);
      assert.equal(plan.unchanged.items, 0);
    });

    it('takes the final state when the item was redeemed then reverted', () => {
      const plan = planGap(
        gapOf({
          redemptions: [
            redemption('r1', 'T1'),
            redemption('r2', 'T1', {
              outcome: 'reverted',
              actorType: 'admin',
              reason: 'wrong person',
              createdAt: '2026-10-09T19:35:00Z',
            }),
          ],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: null }],
        }),
        standbyOf({
          attendees: [withItem('T1', 'meal', '2026-10-09T17:00:00Z')],
        }),
      );

      assert.equal(plan.redemptionInserts.length, 2);
      assert.deepEqual(plan.itemUpdates, [
        {
          attendeeId: idOf('T1'),
          ticketCode: 'T1',
          item: 'meal',
          redeemedAt: null,
        },
      ]);
    });

    it('writes one update per (ticket, item) however many rows there are', () => {
      const plan = planGap(
        gapOf({
          redemptions: [
            redemption('r1', 'T1'),
            redemption('r2', 'T1', { item: 'drink' }),
            redemption('r3', 'T1'),
          ],
          items: [
            { ticketCode: 'T1', item: 'meal', redeemedAt: redeemed },
            { ticketCode: 'T1', item: 'drink', redeemedAt: redeemed },
          ],
        }),
        standbyOf({ attendees: [attendee('T1')] }),
      );

      assert.deepEqual(
        plan.itemUpdates.map((u) => u.item),
        ['drink', 'meal'],
      );
    });

    it('counts an item already at the target as unchanged', () => {
      const plan = planGap(
        gapOf({
          redemptions: [redemption('r1', 'T1')],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: redeemed }],
        }),
        standbyOf({
          attendees: [withItem('T1', 'meal', redeemed)],
          replayedIds: ['r1'],
        }),
      );

      assert.deepEqual(plan.itemUpdates, []);
      assert.equal(plan.unchanged.items, 1);
    });

    it('compares item times as instants, not strings', () => {
      const plan = planGap(
        gapOf({
          redemptions: [redemption('r1', 'T1')],
          items: [
            {
              ticketCode: 'T1',
              item: 'meal',
              redeemedAt: '2026-10-09T19:51:17Z',
            },
          ],
        }),
        standbyOf({
          attendees: [withItem('T1', 'meal', '2026-10-09T19:51:17.000+00:00')],
        }),
      );

      assert.deepEqual(plan.itemUpdates, []);
      assert.equal(plan.unchanged.items, 1);
    });

    it('treats null on both sides as unchanged', () => {
      const plan = planGap(
        gapOf({
          redemptions: [redemption('r1', 'T1', { outcome: 'reverted' })],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: null }],
        }),
        standbyOf({ attendees: [attendee('T1')] }),
      );

      assert.equal(plan.unchanged.items, 1);
    });

    it('keeps dev-server state and flags an item collected on both hosts', () => {
      const plan = planGap(
        gapOf({
          redemptions: [redemption('r1', 'T1')],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: redeemed }],
        }),
        standbyOf({
          attendees: [withItem('T1', 'meal', '2026-10-09T19:40:00Z')],
          ownActivity: [own('j1', 'T1', 'redeemed')],
        }),
      );

      assert.deepEqual(plan.itemUpdates, []);
      assert.equal(plan.unchanged.items, 0);
      assert.deepEqual(
        noticeOf(plan, 'Collected on both hosts — handed over twice')?.lines,
        ['T1 meal'],
      );
    });

    it('counts a dev-server correction to collected as collected', () => {
      const plan = planGap(
        gapOf({
          redemptions: [redemption('r1', 'T1')],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: redeemed }],
        }),
        standbyOf({
          attendees: [withItem('T1', 'meal', '2026-10-09T19:40:00Z')],
          ownActivity: [own('j1', 'T1', 'marked')],
        }),
      );

      assert.ok(noticeOf(plan, 'Collected on both hosts'));
    });

    it('flags an item changed on both hosts with each side stated', () => {
      const plan = planGap(
        gapOf({
          redemptions: [redemption('r1', 'T1')],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: redeemed }],
        }),
        standbyOf({
          attendees: [attendee('T1')],
          ownActivity: [
            own('j1', 'T1', 'redeemed', { createdAt: '2026-10-09T19:40:00Z' }),
            own('j2', 'T1', 'reverted', { createdAt: '2026-10-09T19:45:00Z' }),
          ],
        }),
      );

      assert.deepEqual(plan.itemUpdates, []);
      assert.deepEqual(noticeOf(plan, 'Changed on both hosts')?.lines, [
        'T1 meal: prod-server collected, dev-server not collected',
      ]);
    });

    it('counts an item reverted on both hosts as unchanged', () => {
      const plan = planGap(
        gapOf({
          redemptions: [
            redemption('r1', 'T1', { outcome: 'reverted', actorType: 'admin' }),
          ],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: null }],
        }),
        standbyOf({
          attendees: [attendee('T1')],
          ownActivity: [own('j1', 'T1', 'reverted')],
        }),
      );

      assert.deepEqual(plan.itemUpdates, []);
      assert.equal(plan.unchanged.items, 1);
      assert.deepEqual(plan.notices, []);
    });

    it('uses the gap last row when prod-server reverted', () => {
      const plan = planGap(
        gapOf({
          redemptions: [
            redemption('r1', 'T1'),
            redemption('r2', 'T1', { outcome: 'reverted', actorType: 'admin' }),
          ],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: null }],
        }),
        standbyOf({
          attendees: [withItem('T1', 'meal', '2026-10-09T19:40:00Z')],
          ownActivity: [own('j1', 'T1', 'redeemed')],
        }),
      );

      assert.deepEqual(noticeOf(plan, 'Changed on both hosts')?.lines, [
        'T1 meal: prod-server not collected, dev-server collected',
      ]);
    });

    it('does not treat replayed gap rows as dev-server activity', () => {
      const plan = planGap(
        gapOf({
          redemptions: [redemption('r1', 'T1')],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: redeemed }],
        }),
        standbyOf({
          attendees: [withItem('T1', 'meal', redeemed)],
          ownActivity: [own('r1', 'T1', 'redeemed')],
          replayedIds: ['r1'],
        }),
      );

      assert.deepEqual(plan.notices, []);
      assert.equal(plan.unchanged.items, 1);
    });

    it('treats own activity on another item as no activity', () => {
      const plan = planGap(
        gapOf({
          redemptions: [redemption('r1', 'T1')],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: redeemed }],
        }),
        standbyOf({
          attendees: [attendee('T1')],
          ownActivity: [own('j1', 'T1', 'redeemed', { item: 'drink' })],
        }),
      );

      assert.equal(plan.itemUpdates.length, 1);
      assert.deepEqual(plan.notices, []);
    });

    it('still inserts audit rows but leaves item state for an archived attendee', () => {
      const plan = planGap(
        gapOf({
          redemptions: [redemption('r1', 'T1')],
          items: [{ ticketCode: 'T1', item: 'meal', redeemedAt: redeemed }],
        }),
        standbyOf({ attendees: [attendee('T1', { archived: true })] }),
      );

      assert.equal(plan.redemptionInserts.length, 1);
      assert.deepEqual(plan.itemUpdates, []);
      assert.deepEqual(
        noticeOf(plan, 'Archived on dev-server — item state not changed')
          ?.lines,
        ['T1'],
      );
    });

    it('sorts item updates by ticket code, then item', () => {
      const plan = planGap(
        gapOf({
          redemptions: [
            redemption('r1', 'T2'),
            redemption('r2', 'T1', { item: 'tshirt' }),
            redemption('r3', 'T1', { item: 'drink' }),
          ],
          items: [
            { ticketCode: 'T2', item: 'meal', redeemedAt: redeemed },
            { ticketCode: 'T1', item: 'tshirt', redeemedAt: redeemed },
            { ticketCode: 'T1', item: 'drink', redeemedAt: redeemed },
          ],
        }),
        standbyOf({ attendees: [attendee('T1'), attendee('T2')] }),
      );

      assert.deepEqual(
        plan.itemUpdates.map((u) => `${u.ticketCode} ${u.item}`),
        ['T1 drink', 'T1 tshirt', 'T2 meal'],
      );
    });
  });

  describe('notices', () => {
    it('lists tickets edited on prod-server, sorted', () => {
      const plan = planGap(gapOf({ edited: ['T2', 'T1'] }), standbyOf());

      assert.deepEqual(plan.notices, [
        {
          heading:
            'Changed on prod-server in the gap by something other than a check-in or redemption — compare by hand',
          lines: ['T1', 'T2'],
        },
      ]);
    });

    it('reports raffle draws on dev-server with the count', () => {
      const plan = planGap(gapOf(), standbyOf({ drawsSinceTakenAt: 2 }));

      assert.deepEqual(
        noticeOf(plan, 'Raffle already drawn on dev-server')?.lines,
        ['2 draw(s) since the snapshot'],
      );
    });

    it('omits notices with no lines', () => {
      const plan = planGap(gapOf(), standbyOf({ drawsSinceTakenAt: 0 }));

      assert.deepEqual(plan.notices, []);
    });

    it('sorts the lines within a notice', () => {
      const mk = (code: string) => [redemption(`r-${code}`, code)];
      const plan = planGap(
        gapOf({
          redemptions: [...mk('T2'), ...mk('T1')],
          items: [
            { ticketCode: 'T2', item: 'meal', redeemedAt: null },
            { ticketCode: 'T1', item: 'meal', redeemedAt: null },
          ],
        }),
        standbyOf({
          attendees: [attendee('T1'), attendee('T2')],
          ownActivity: [
            own('j1', 'T2', 'redeemed'),
            own('j2', 'T1', 'redeemed'),
          ],
        }),
      );

      assert.deepEqual(noticeOf(plan, 'Collected on both hosts')?.lines, [
        'T1 meal',
        'T2 meal',
      ]);
    });
  });

  describe('idempotency', () => {
    it('plans no writes against a standby that already reflects a replay', () => {
      const redeemed = '2026-10-09T19:30:00Z';
      const gap = gapOf({
        checkins: [
          checkin('T1'),
          checkin('V1', { role: 'volunteer', checkinNumber: null }),
        ],
        redemptions: [
          redemption('r1', 'T1'),
          redemption('r2', 'T1', { item: 'drink' }),
          redemption('r3', 'T1', { item: 'drink', outcome: 'reverted' }),
        ],
        items: [
          { ticketCode: 'T1', item: 'meal', redeemedAt: redeemed },
          { ticketCode: 'T1', item: 'drink', redeemedAt: null },
        ],
      });
      const standby = standbyOf({
        attendees: [
          withItem('T1', 'meal', '2026-10-09T19:30:00.000+00:00', {
            checkinComplete: true,
            checkinNumber: 1050,
            checkinAt: gap.checkins[0]?.checkinAt ?? null,
          }),
          attendee('V1', {
            role: 'volunteer',
            checkinComplete: true,
            checkinAt: gap.checkins[1]?.checkinAt ?? null,
          }),
        ],
        heldNumbers: [{ checkinNumber: 1050, ticketCode: 'T1' }],
        ownActivity: gap.redemptions.map((r) =>
          own(r.redemptionId, r.ticketCode, r.outcome, { item: r.item }),
        ),
        replayedIds: ['r1', 'r2', 'r3'],
      });

      assert.deepEqual(planGap(gap, standby), {
        checkins: [],
        redemptionInserts: [],
        itemUpdates: [],
        unchanged: { checkins: 2, items: 2 },
        problems: [],
        notices: [],
      });
    });
  });
});
