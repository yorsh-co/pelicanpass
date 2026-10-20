import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGap } from './gap-input.ts';

const ID = '11111111-1111-4111-8111-111111111111';

const valid = () => ({
  takenAt: '2026-10-09T18:00:00Z',
  checkins: [
    {
      ticketCode: 'xabc12',
      attendeeId: ID,
      role: 'participant',
      checkinNumber: 7,
      checkinAt: '2026-10-09T18:05:00.123456+00:00',
    },
  ],
  redemptions: [
    {
      redemptionId: ID,
      ticketCode: 'xabc12',
      attendeeId: ID,
      item: 'meal',
      outcome: 'redeemed',
      redeemedBy: ID,
      actorType: 'volunteer',
      reason: null,
      createdAt: '2026-10-09T18:06:00Z',
    },
  ],
  items: [
    { ticketCode: 'xabc12', item: 'meal', redeemedAt: '2026-10-09T18:06:00Z' },
  ],
  created: [],
  edited: [],
});

/** The first row, asserted present so a test can mutate it. */
const first = <T>(rows: T[]): T => {
  const [row] = rows;

  assert.ok(row);

  return row;
};

const problemsOf = (value: unknown): string[] => {
  const result = parseGap(JSON.stringify(value));

  assert.ok('problems' in result, 'expected problems');

  return result.problems;
};

describe('parseGap', () => {
  it('accepts a complete gap', () => {
    const result = parseGap(JSON.stringify(valid()));

    assert.ok('gap' in result);
    assert.deepEqual(result.gap, valid());
  });

  it('rejects text that is not JSON', () => {
    assert.deepEqual(parseGap('{nope'), {
      problems: ['input: not valid JSON'],
    });
  });

  it('rejects a non-object', () => {
    assert.deepEqual(problemsOf([]), ['input: expected a JSON object']);
  });

  it('names the path of a missing array', () => {
    const gap: Partial<ReturnType<typeof valid>> = valid();

    delete gap.items;

    assert.deepEqual(problemsOf(gap), ['items: expected an array']);
  });

  it('rejects a timestamp without a zone or that does not parse', () => {
    const gap = valid();

    gap.takenAt = '2026-10-09T18:00:00';
    first(gap.checkins).checkinAt = '2026-13-45T99:00:00Z';

    assert.deepEqual(problemsOf(gap), [
      'input.takenAt: expected an ISO 8601 timestamp with a zone',
      'checkins[0].checkinAt: expected an ISO 8601 timestamp with a zone',
    ]);
  });

  it('rejects an item outside the list', () => {
    const gap = valid();

    first(gap.redemptions).item = 'badge';

    assert.match(
      problemsOf(gap)[0] ?? '',
      /^redemptions\[0\]\.item: expected one of/,
    );
  });

  it('rejects an outcome the replay does not carry', () => {
    const gap = valid();

    first(gap.redemptions).outcome = 'duplicate';

    assert.match(
      problemsOf(gap)[0] ?? '',
      /^redemptions\[0\]\.outcome: expected one of redeemed, marked, reverted/,
    );
  });

  it('rejects ids that are not UUIDs', () => {
    const gap = valid();

    first(gap.checkins).attendeeId = 'x; DROP TABLE attendees';

    assert.deepEqual(problemsOf(gap), [
      'checkins[0].attendeeId: expected a UUID',
    ]);
  });

  it('rejects a ticket code that is not a string', () => {
    const gap = valid();

    (gap.items[0] as Record<string, unknown>).ticketCode = 5;

    assert.deepEqual(problemsOf(gap), [
      'items[0].ticketCode: expected a non-empty string',
    ]);
  });

  it('rejects a bad check-in number', () => {
    const gap = valid();

    first(gap.checkins).checkinNumber = 1.5;

    assert.deepEqual(problemsOf(gap), [
      'checkins[0].checkinNumber: expected a positive integer or null',
    ]);
  });

  it('accepts a volunteer without a number', () => {
    const gap = valid();

    first(gap.checkins).role = 'volunteer';
    first(gap.checkins).checkinNumber = null as never;

    assert.ok('gap' in parseGap(JSON.stringify(gap)));
  });

  it('ties corrections to an admin and a reason, as the table does', () => {
    const gap = valid();

    first(gap.redemptions).outcome = 'marked';

    assert.deepEqual(problemsOf(gap), [
      'redemptions[0]: marked needs actorType admin and a reason',
    ]);

    first(gap.redemptions).actorType = 'admin';
    first(gap.redemptions).reason = 'offline' as never;

    assert.ok('gap' in parseGap(JSON.stringify(gap)));
  });

  it('rejects a reason on a plain redemption', () => {
    const gap = valid();

    first(gap.redemptions).reason = 'other' as never;

    assert.deepEqual(problemsOf(gap), [
      'redemptions[0].reason: redeemed must not carry a reason',
    ]);
  });

  it('rejects a duplicate redemption id', () => {
    const gap = valid();

    gap.redemptions.push({ ...first(gap.redemptions) });

    assert.deepEqual(problemsOf(gap), [
      'redemptions[1].redemptionId: duplicate id',
    ]);
  });

  it('caps the problems it lists', () => {
    const gap = valid();

    gap.created = Array.from({ length: 80 }, () => 1 as never);

    const problems = problemsOf(gap);

    assert.equal(problems.length, 51);
    assert.equal(problems.at(-1), '…and 30 more');
  });

  it('never echoes a rejected value', () => {
    const gap = valid();

    first(gap.redemptions).item = 'Ana Lima';

    assert.doesNotMatch(problemsOf(gap).join('\n'), /Ana Lima/);
  });
});
