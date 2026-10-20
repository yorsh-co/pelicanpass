import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { instantToWallTime, wallTimeToInstant } from './zoned-time.ts';

const SAO_PAULO = 'America/Sao_Paulo';
const NEW_YORK = 'America/New_York';
const at = (iso: string): number => Date.parse(iso);

describe('wallTimeToInstant', () => {
  it('reads a wall time in the given zone, not the host clock', () => {
    assert.equal(
      wallTimeToInstant('2026-10-03T18:00', SAO_PAULO),
      at('2026-10-03T18:00:00-03:00'),
    );
    assert.equal(
      wallTimeToInstant('2026-10-03T18:00', 'UTC'),
      at('2026-10-03T18:00:00Z'),
    );
  });

  it('accepts seconds', () => {
    assert.equal(
      wallTimeToInstant('2026-10-03T18:00:30', SAO_PAULO),
      at('2026-10-03T18:00:30-03:00'),
    );
  });

  it('follows a daylight-saving offset on either side of the change', () => {
    assert.equal(
      wallTimeToInstant('2026-03-07T12:00', NEW_YORK),
      at('2026-03-07T12:00:00-05:00'),
    );
    assert.equal(
      wallTimeToInstant('2026-03-09T12:00', NEW_YORK),
      at('2026-03-09T12:00:00-04:00'),
    );
  });

  it('refuses a wall time skipped by the spring-forward gap', () => {
    assert.equal(wallTimeToInstant('2026-03-08T02:30', NEW_YORK), null);
  });

  it('refuses a wall time doubled by the fall-back overlap', () => {
    assert.equal(wallTimeToInstant('2026-11-01T01:30', NEW_YORK), null);
  });

  it('refuses dates and times that do not exist', () => {
    assert.equal(wallTimeToInstant('2026-02-30T10:00', SAO_PAULO), null);
    assert.equal(wallTimeToInstant('2026-10-03T24:00', SAO_PAULO), null);
    assert.equal(wallTimeToInstant('2026-10-03T18:60', SAO_PAULO), null);
  });

  it('refuses anything but the datetime-local shape', () => {
    for (const value of [
      '',
      '2026-10-03',
      '2026-10-03 18:00',
      '2026-10-03T18:00Z',
      '2026-10-03T18:00:00-03:00',
      '2026-10-03T18:00:00.000',
    ]) {
      assert.equal(wallTimeToInstant(value, SAO_PAULO), null, value);
    }
  });
});

describe('instantToWallTime', () => {
  it('prints an instant in the given zone, to the minute', () => {
    assert.equal(
      instantToWallTime(at('2026-10-03T21:00:00Z'), SAO_PAULO),
      '2026-10-03T18:00',
    );
  });

  it('keeps seconds only when there are some', () => {
    assert.equal(
      instantToWallTime(at('2026-10-03T21:00:30Z'), SAO_PAULO),
      '2026-10-03T18:00:30',
    );
  });

  it('round-trips through wallTimeToInstant', () => {
    for (const iso of [
      '2026-10-03T16:00:00Z',
      '2026-10-04T02:59:00Z',
      '2026-03-09T16:00:00Z',
    ]) {
      for (const zone of [SAO_PAULO, NEW_YORK, 'UTC']) {
        const instant = at(iso);

        assert.equal(
          wallTimeToInstant(instantToWallTime(instant, zone), zone),
          instant,
          `${iso} in ${zone}`,
        );
      }
    }
  });
});
