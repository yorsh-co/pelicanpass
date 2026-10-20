import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addressFor, spread } from './addresses.ts';

import type { AddressPlan } from './addresses.ts';

const VENUE = '203.0.113.10';

const plan = (overrides: Partial<AddressPlan>): AddressPlan => ({
  ipMode: 'cgnat',
  venueIp: VENUE,
  wifiShare: 0.7,
  carrierIps: 10,
  ...overrides,
});

/** Attendees per address over the first `room` indexes. */
const tally = (room: number, settings: AddressPlan): Map<string, number> => {
  const counts = new Map<string, number>();

  for (let i = 0; i < room; i++) {
    const address = addressFor(i, settings);

    counts.set(address, (counts.get(address) ?? 0) + 1);
  }

  return counts;
};

describe('addressFor', () => {
  it('puts the whole room on the venue address in single mode', () => {
    const counts = tally(500, plan({ ipMode: 'single' }));

    assert.deepEqual([...counts], [[VENUE, 500]]);
  });

  it('gives everyone an address of their own in spread mode', () => {
    assert.equal(tally(500, plan({ ipMode: 'spread' })).size, 500);
    assert.equal(addressFor(258, plan({ ipMode: 'spread' })), spread(10, 258));
  });

  it('keeps the Wi-Fi share within one attendee of any prefix', () => {
    for (const wifiShare of [0, 0.1, 0.15, 0.29, 0.7, 1]) {
      let venue = 0;

      for (let i = 0; i < 1000; i++) {
        if (addressFor(i, plan({ wifiShare })) === VENUE) venue++;
        assert.ok(
          Math.abs(venue - (i + 1) * wifiShare) <= 1,
          `share ${String(wifiShare)} after ${String(i + 1)}: ${String(venue)}`,
        );
      }
    }
  });

  it('spreads the rest evenly over every carrier address', () => {
    for (const carrierIps of [1, 3, 5, 10, 254]) {
      const counts = tally(1000, plan({ wifiShare: 0.15, carrierIps }));
      const carriers = [...counts].filter(([address]) => address !== VENUE);
      const sizes = carriers.map(([, n]) => n);

      assert.equal(carriers.length, carrierIps);
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
      assert.equal(counts.get(VENUE), 150);
    }
  });

  it('uses all ten carrier addresses on the defaults', () => {
    const counts = tally(500, plan({}));

    assert.equal(counts.get(VENUE), 350);
    assert.equal(counts.size, 11);
  });
});
