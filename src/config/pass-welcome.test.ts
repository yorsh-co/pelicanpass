import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeStoredSchedule,
  firstOutOfOrder,
  parseWelcomeSchedule,
  welcomeLineAt,
  welcomePhaseFor,
} from './pass-welcome.ts';

const KEY = 'PASS_WELCOME_SCHEDULE';
const at = (iso: string): number => Date.parse(iso);

describe('parseWelcomeSchedule', () => {
  it('reads an unset or blank value as an empty schedule', () => {
    assert.deepEqual(parseWelcomeSchedule(KEY, undefined), []);
    assert.deepEqual(parseWelcomeSchedule(KEY, '  '), []);
  });

  it('reads entries in order, trimming around them', () => {
    assert.deepEqual(
      parseWelcomeSchedule(
        KEY,
        'default@2026-10-03T13:00:00-03:00, survey@2026-10-03T18:00:00-03:00 ,thanks@2026-10-03T22:00:00-03:00,arrival@2026-10-04T11:00:00Z',
      ),
      [
        { phase: 'default', at: at('2026-10-03T16:00:00Z') },
        { phase: 'survey', at: at('2026-10-03T21:00:00Z') },
        { phase: 'thanks', at: at('2026-10-04T01:00:00Z') },
        { phase: 'arrival', at: at('2026-10-04T11:00:00Z') },
      ],
    );
  });

  it('refuses an entry without a separator', () => {
    assert.throws(
      () => parseWelcomeSchedule(KEY, 'default 2026-10-03T13:00:00-03:00'),
      /"phase@instant"/,
    );
  });

  it('refuses an unknown phase', () => {
    assert.throws(
      () => parseWelcomeSchedule(KEY, 'lunch@2026-10-03T13:00:00-03:00'),
      /unknown phase "lunch"/,
    );
  });

  it('refuses a custom line, which only the admin editor can set', () => {
    assert.throws(
      () => parseWelcomeSchedule(KEY, 'custom@2026-10-03T13:00:00-03:00'),
      /unknown phase "custom"/,
    );
  });

  it('refuses an instant without an offset', () => {
    assert.throws(
      () => parseWelcomeSchedule(KEY, 'default@2026-10-03T13:00:00'),
      /explicit UTC offset/,
    );
  });

  it('refuses an instant that does not parse', () => {
    assert.throws(
      () => parseWelcomeSchedule(KEY, 'default@2026-13-45T13:00:00-03:00'),
      /ISO-8601/,
    );
  });

  it('refuses entries out of order or at the same instant', () => {
    assert.throws(
      () =>
        parseWelcomeSchedule(
          KEY,
          'survey@2026-10-03T18:00:00-03:00,default@2026-10-03T13:00:00-03:00',
        ),
      /ascending order/,
    );
    assert.throws(
      () =>
        parseWelcomeSchedule(
          KEY,
          'default@2026-10-03T13:00:00-03:00,survey@2026-10-03T16:00:00Z',
        ),
      /ascending order/,
    );
  });
});

describe('firstOutOfOrder', () => {
  it('reads an empty or single-entry list as in order', () => {
    assert.equal(firstOutOfOrder([]), -1);
    assert.equal(firstOutOfOrder([{ phase: 'default', at: 1 }]), -1);
  });

  it('accepts strictly ascending entries', () => {
    assert.equal(
      firstOutOfOrder([
        { phase: 'default', at: 1 },
        { phase: 'survey', at: 2 },
        { phase: 'arrival', at: 3 },
      ]),
      -1,
    );
  });

  it('names the first entry that is not after the one before it', () => {
    assert.equal(
      firstOutOfOrder([
        { phase: 'default', at: 1 },
        { phase: 'survey', at: 3 },
        { phase: 'thanks', at: 3 },
        { phase: 'arrival', at: 2 },
      ]),
      2,
    );
  });
});

describe('decodeStoredSchedule', () => {
  it('reads stored entries back into instants', () => {
    assert.deepEqual(
      decodeStoredSchedule([
        { phase: 'default', at: '2026-10-03T16:00:00.000Z' },
        { phase: 'survey', at: '2026-10-03T21:00:00.000Z' },
      ]),
      [
        { phase: 'default', at: at('2026-10-03T16:00:00Z') },
        { phase: 'survey', at: at('2026-10-03T21:00:00Z') },
      ],
    );
  });

  it('reads an empty list as an empty schedule', () => {
    assert.deepEqual(decodeStoredSchedule([]), []);
  });

  it('reads a custom line with its text', () => {
    assert.deepEqual(
      decodeStoredSchedule([
        {
          phase: 'custom',
          text: 'Intervalo: lanche no pátio!',
          at: '2026-10-03T18:30:00.000Z',
        },
      ]),
      [
        {
          phase: 'custom',
          text: 'Intervalo: lanche no pátio!',
          at: at('2026-10-03T18:30:00Z'),
        },
      ],
    );
  });

  it('refuses a custom line whose text the editor would not have saved', () => {
    const when = '2026-10-03T18:30:00.000Z';

    for (const text of [
      undefined,
      1,
      '',
      ' padded ',
      'a\u202Eb',
      'x'.repeat(101),
    ]) {
      assert.equal(
        decodeStoredSchedule([{ phase: 'custom', text, at: when }]),
        null,
        JSON.stringify(text),
      );
    }
  });

  it('refuses anything the editor could not have saved', () => {
    for (const stored of [
      null,
      {},
      'default@2026-10-03T13:00:00-03:00',
      [null],
      [{ phase: 'lunch', at: '2026-10-03T16:00:00.000Z' }],
      [{ phase: 'default', at: 1 }],
      [{ phase: 'default', at: 'soon' }],
      [
        { phase: 'survey', at: '2026-10-03T21:00:00.000Z' },
        { phase: 'default', at: '2026-10-03T16:00:00.000Z' },
      ],
    ]) {
      assert.equal(decodeStoredSchedule(stored), null, JSON.stringify(stored));
    }
  });
});

describe('welcomeLineAt', () => {
  const schedule = parseWelcomeSchedule(
    KEY,
    'default@2026-10-03T13:00:00-03:00,survey@2026-10-03T18:00:00-03:00,arrival@2026-10-04T08:00:00-03:00',
  );

  it('shows arrival with no schedule', () => {
    assert.deepEqual(welcomeLineAt([], at('2026-10-03T16:00:00Z')), {
      phase: 'arrival',
    });
  });

  it('shows arrival before the first entry', () => {
    assert.deepEqual(welcomeLineAt(schedule, at('2026-10-03T15:59:59.999Z')), {
      phase: 'arrival',
    });
  });

  it('switches exactly on an entry', () => {
    assert.deepEqual(welcomeLineAt(schedule, at('2026-10-03T16:00:00Z')), {
      phase: 'default',
    });
  });

  it('holds a phase between entries', () => {
    assert.deepEqual(welcomeLineAt(schedule, at('2026-10-03T20:59:59Z')), {
      phase: 'default',
    });
    assert.deepEqual(welcomeLineAt(schedule, at('2026-10-03T23:00:00Z')), {
      phase: 'survey',
    });
  });

  it("carries a custom line's text", () => {
    const custom = [
      { phase: 'custom' as const, text: 'Lanche no pátio', at: 10 },
      { phase: 'default' as const, at: 20 },
    ];

    assert.deepEqual(welcomeLineAt(custom, 15), {
      phase: 'custom',
      text: 'Lanche no pátio',
    });
    assert.deepEqual(welcomeLineAt(custom, 20), { phase: 'default' });
  });

  it('returns to a phase scheduled again, and holds the last', () => {
    assert.deepEqual(welcomeLineAt(schedule, at('2026-10-04T11:00:00Z')), {
      phase: 'arrival',
    });
    assert.deepEqual(welcomeLineAt(schedule, at('2026-10-09T00:00:00Z')), {
      phase: 'arrival',
    });
  });
});

describe('welcomePhaseFor', () => {
  it('keeps survey while the questionnaire is open and unanswered', () => {
    assert.deepEqual(
      welcomePhaseFor({ phase: 'survey' }, { open: true, completed: false }),
      { phase: 'survey' },
    );
  });

  it('thanks an attendee who has answered, open or not', () => {
    assert.deepEqual(
      welcomePhaseFor({ phase: 'survey' }, { open: true, completed: true }),
      { phase: 'thanks' },
    );
    assert.deepEqual(
      welcomePhaseFor({ phase: 'survey' }, { open: false, completed: true }),
      { phase: 'thanks' },
    );
  });

  it('falls back to default while the questionnaire is not open to them', () => {
    assert.deepEqual(
      welcomePhaseFor({ phase: 'survey' }, { open: false, completed: false }),
      { phase: 'default' },
    );
  });

  it('leaves every other phase to the schedule', () => {
    for (const phase of ['arrival', 'default', 'thanks'] as const) {
      assert.deepEqual(
        welcomePhaseFor({ phase }, { open: true, completed: true }),
        { phase },
      );
      assert.deepEqual(
        welcomePhaseFor({ phase }, { open: false, completed: false }),
        { phase },
      );
    }
  });

  it('shows a custom line to everyone, whatever their questionnaire', () => {
    const line = { phase: 'custom', text: 'Lanche no pátio' } as const;

    assert.deepEqual(
      welcomePhaseFor(line, { open: true, completed: true }),
      line,
    );
    assert.deepEqual(
      welcomePhaseFor(line, { open: false, completed: false }),
      line,
    );
  });
});
