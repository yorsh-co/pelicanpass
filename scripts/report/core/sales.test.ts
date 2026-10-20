import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { saleBuckets, salesByBucket, salesEventDate } from './sales.ts';

import type { Attendee } from './checkin.ts';

const person = (patch: Partial<Attendee> = {}): Attendee => ({
  role: 'participant',
  walkIn: false,
  church: null,
  ageDetail: null,
  saleDate: null,
  checkedIn: false,
  checkinAt: null,
  archived: false,
  items: {
    meal: { option: null, redeemedAt: null },
    drink: { option: null, redeemedAt: null },
    tshirt: { option: null, redeemedAt: null },
    lunch: { option: null, redeemedAt: null },
    tshirtVolunteer: { option: null, redeemedAt: null },
  },
  ...patch,
});

const sold = (saleDate: string | null, patch: Partial<Attendee> = {}) =>
  person({ saleDate, ...patch });

describe('saleBuckets', () => {
  it('splits 2026-10-17 into months, weeks, days and the event day', () => {
    assert.deepEqual(saleBuckets('2026-10-17'), [
      { id: 'months-6-plus', label: '+6 meses', from: null, to: '2026-04-16' },
      {
        id: 'months-3-6',
        label: '3–6 meses',
        from: '2026-04-17',
        to: '2026-07-16',
      },
      {
        id: 'months-2-3',
        label: '2–3 meses',
        from: '2026-07-17',
        to: '2026-08-16',
      },
      {
        id: 'months-1-2',
        label: '1–2 meses',
        from: '2026-08-17',
        to: '2026-09-18',
      },
      {
        id: 'week-3',
        label: '3–4 semanas',
        from: '2026-09-19',
        to: '2026-09-25',
      },
      {
        id: 'week-2',
        label: '2–3 semanas',
        from: '2026-09-26',
        to: '2026-10-02',
      },
      {
        id: 'week-1',
        label: '1–2 semanas',
        from: '2026-10-03',
        to: '2026-10-09',
      },
      {
        id: 'week-0',
        label: '0–1 semana',
        from: '2026-10-10',
        to: '2026-10-16',
      },
      {
        id: 'event',
        label: 'Dia do evento',
        from: '2026-10-17',
        to: '2026-10-17',
      },
    ]);
  });

  it('clamps month boundaries at the end of a month', () => {
    const [six, three, two, one] = saleBuckets('2026-08-31');

    assert.equal(six?.to, '2026-02-27');
    assert.deepEqual([three?.from, three?.to], ['2026-02-28', '2026-05-30']);
    assert.deepEqual([two?.from, two?.to], ['2026-05-31', '2026-06-29']);
    assert.deepEqual([one?.from, one?.to], ['2026-06-30', '2026-08-02']);
  });

  it('crosses a year boundary', () => {
    const buckets = saleBuckets('2027-01-05');
    const label = (id: string): string | undefined =>
      buckets.find((b) => b.id === id)?.label;

    assert.equal(buckets[0]?.to, '2026-07-04');
    assert.equal(buckets[1]?.from, '2026-07-05');
    assert.equal(buckets.find((b) => b.id === 'week-3')?.from, '2026-12-08');
    assert.equal(buckets.find((b) => b.id === 'week-1')?.to, '2026-12-28');
    assert.equal(label('week-3'), '3–4 semanas');
    assert.equal(label('week-0'), '0–1 semana');
    assert.equal(label('event'), 'Dia do evento');
    assert.deepEqual(
      [
        buckets.find((b) => b.id === 'week-0')?.from,
        buckets.find((b) => b.id === 'week-0')?.to,
      ],
      ['2026-12-29', '2027-01-04'],
    );
  });

  it('covers every day without gaps or overlaps', () => {
    const buckets = saleBuckets('2026-03-31');

    for (const [i, bucket] of buckets.entries()) {
      const next = buckets[i + 1];

      if (!next || bucket.to === null || next.from === null) continue;
      const day = new Date(Date.parse(bucket.to) + 86_400_000)
        .toISOString()
        .slice(0, 10);

      assert.equal(next.from, day);
    }
  });
});

describe('salesByBucket', () => {
  const EVENT = '2026-10-17';
  const counts = (rows: ReturnType<typeof salesByBucket>): number[] =>
    rows.map((r) => r.tickets);

  it('counts tickets per bucket, keeping empty ones', () => {
    const rows = salesByBucket(
      [
        sold('2025-01-01'),
        sold('2026-04-16'),
        sold('2026-04-17'),
        sold('2026-09-18'),
        sold('2026-09-19'),
        sold('2026-09-19'),
        sold('2026-10-09'),
        sold('2026-10-10'),
        sold('2026-10-16'),
        sold('2026-10-17'),
      ],
      EVENT,
    );

    assert.deepEqual(counts(rows), [2, 1, 0, 1, 2, 0, 1, 2, 1]);
    assert.equal(rows.length, 9);
    assert.ok(rows.every((r) => r.id !== 'none'));
  });

  it('adds a "Sem data" row only when some tickets are undated', () => {
    const rows = salesByBucket([sold('2026-10-01'), sold(null)], EVENT);

    assert.deepEqual(rows.at(-1), {
      id: 'none',
      label: 'Sem data',
      tickets: 1,
    });
    assert.equal(rows.length, 10);
  });

  it('ignores archived tickets and volunteers', () => {
    const rows = salesByBucket(
      [
        sold('2026-10-01'),
        sold('2026-10-01', { archived: true }),
        sold('2026-10-01', { role: 'volunteer' }),
        sold(null, { archived: true }),
        sold(null, { role: 'volunteer' }),
      ],
      EVENT,
    );

    assert.equal(
      rows.reduce((sum, r) => sum + r.tickets, 0),
      1,
    );
    assert.ok(rows.every((r) => r.id !== 'none'));
  });

  it('counts sales after the event on the event day', () => {
    const rows = salesByBucket([sold('2026-10-20')], EVENT);

    assert.equal(rows.find((r) => r.id === 'event')?.tickets, 1);
  });

  it('is empty when no participant has a sale date', () => {
    assert.deepEqual(salesByBucket([sold(null), sold(null)], EVENT), []);
    assert.deepEqual(salesByBucket([], EVENT), []);
    assert.deepEqual(
      salesByBucket([sold('2026-10-01', { role: 'volunteer' })], EVENT),
      [],
    );
  });
});

describe('salesEventDate', () => {
  it('uses the São Paulo date of the first check-in', () => {
    const late = Date.parse('2026-10-18T01:30:00Z');
    const first = Date.parse('2026-10-17T22:00:00Z');

    assert.equal(
      salesEventDate([
        sold('2026-10-30'),
        person({ checkedIn: true, checkinAt: late }),
        person({ checkedIn: true, checkinAt: first }),
      ]),
      '2026-10-17',
    );
    assert.equal(
      salesEventDate([person({ checkedIn: true, checkinAt: late })]),
      '2026-10-17',
    );
  });

  it('falls back to the latest participant sale date', () => {
    assert.equal(
      salesEventDate([
        sold('2026-09-01'),
        sold('2026-10-02'),
        sold('2026-12-01', { archived: true }),
        sold('2026-12-02', { role: 'volunteer' }),
      ]),
      '2026-10-02',
    );
  });

  it('is null without check-ins or sale dates', () => {
    assert.equal(salesEventDate([sold(null)]), null);
    assert.equal(salesEventDate([]), null);
  });
});
