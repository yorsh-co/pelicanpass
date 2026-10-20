import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatDuration, formatTime, slotStart } from './time.ts';

const at = (iso: string): number => Date.parse(iso);

describe('slotStart', () => {
  it('aligns to local wall-clock slots in the event zone', () => {
    // 14:07 in São Paulo (-03) is 17:07Z.
    assert.equal(
      slotStart(at('2026-10-18T17:07:30Z'), 15),
      at('2026-10-18T17:00:00Z'),
    );
    assert.equal(
      slotStart(at('2026-10-18T17:29:59.999Z'), 15),
      at('2026-10-18T17:15:00Z'),
    );
  });

  it('uses the zone offset rather than assuming -03', () => {
    // India is +05:30: a 60-minute slot starts at :30 past UTC hours.
    assert.equal(
      slotStart(at('2026-10-18T10:45:00Z'), 60, 'Asia/Kolkata'),
      at('2026-10-18T10:30:00Z'),
    );
  });
});

describe('formatTime', () => {
  it('formats HH:mm in the zone', () => {
    assert.equal(formatTime(at('2026-10-18T17:07:00Z')), '14:07');
    assert.equal(formatTime(at('2026-10-18T03:05:00Z')), '00:05');
  });
});

describe('formatDuration', () => {
  it('formats minutes and hours in pt-BR', () => {
    assert.equal(formatDuration(12 * 60_000), '12 min');
    assert.equal(formatDuration(85 * 60_000), '1 h 25 min');
    assert.equal(formatDuration(120 * 60_000), '2 h');
    assert.equal(formatDuration(0), '0 min');
  });
});
