import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRosterCsv, planImport } from './admin.attendees.import.ts';
import { ITEM_OPTIONS } from './admin.item-options.ts';

import type { ExistingAttendee, RosterRow } from './admin.attendees.import.ts';

const EVENT = 'event-a';
const HEADER =
  'ticket_code,name,phone,role,meal_option,drink_option,tshirt_size';
const MEAL = ITEM_OPTIONS.meal[0] ?? '';
const TSHIRT = ITEM_OPTIONS.tshirt[0] ?? '';
const LUNCH = ITEM_OPTIONS.lunch[0] ?? '';
const LUNCH_HEADER = `${HEADER},lunch_option`;
const VOLUNTEER_TSHIRT = ITEM_OPTIONS.tshirt_volunteer[0] ?? '';
const VOLUNTEER_TSHIRT_HEADER = `${HEADER},tshirt_volunteer_size`;
const TEAM_HEADER = `${HEADER},team,team_role,checkin_time`;

/**
 * Parses a roster built from the standard header and the given lines, and
 * asserts it produced no problems.
 */
const parseClean = (...lines: string[]): RosterRow[] => {
  const parsed = parseRosterCsv([HEADER, ...lines].join('\n'));

  assert.deepEqual(parsed.problems, []);

  return parsed.rows;
};

/** An existing row matching `xabc12` as {@link parseClean} would read it. */
const existing = (
  overrides: Partial<ExistingAttendee> = {},
): ExistingAttendee => ({
  attendee_id: 'id-abc12',
  event_id: EVENT,
  ticket_code: 'xabc12',
  attendee_role: 'participant',
  checkin_complete: false,
  archived_at: null,
  attendee_name: 'Ana Lima',
  attendee_phone: '5511900001234',
  meal_option: MEAL,
  drink_option: null,
  tshirt_size: null,
  lunch_option: null,
  tshirt_volunteer_size: null,
  team: null,
  team_role: null,
  checkin_time: null,
  meal_redeemed_at: null,
  drink_redeemed_at: null,
  tshirt_redeemed_at: null,
  lunch_redeemed_at: null,
  tshirt_volunteer_redeemed_at: null,
  ...overrides,
});

const ANA = `xabc12,Ana Lima,5511900001234,,${MEAL},,`;

describe('parseRosterCsv', () => {
  it('normalises code case, name whitespace and phone punctuation', () => {
    const [row] = parseClean(
      `XABC12,"  Ana   Lima ","+55 (11) 90000-1234",,${MEAL},,`,
    );

    assert.equal(row?.ticketCode, 'xabc12');
    assert.equal(row.role, 'participant');
    assert.equal(row.fields.attendee_name, 'Ana Lima');
    assert.equal(row.fields.attendee_phone, '+5511900001234');
    assert.equal(row.fields.meal_option, MEAL);
    assert.equal(row.fields.drink_option, null);
  });

  it('reads a BOM, quoted commas and CRLF line endings', () => {
    const parsed = parseRosterCsv(
      `\uFEFF${HEADER}\r\nxabc12,"Lima, Ana",5511900001234,,,,\r\n`,
    );

    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.rows[0]?.fields.attendee_name, 'Lima, Ana');
  });

  it('accepts only the required columns, in any order and case', () => {
    const parsed = parseRosterCsv(
      'Phone,TICKET_CODE,name\n5511900001234,xabc12,Ana Lima',
    );

    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.rows[0]?.fields.tshirt_size, null);
  });

  it('takes a blank role from the code prefix', () => {
    const [row] = parseClean('vabc12,Bruno Maia,5511900002222,,,,');

    assert.equal(row?.role, 'volunteer');
  });

  it('refuses unknown, repeated and missing header columns', () => {
    const parsed = parseRosterCsv('ticket_code,name,name,email\nxabc12,a,b,c');

    assert.equal(parsed.rows.length, 0);
    assert.equal(parsed.problems.length, 3);
    assert.match(parsed.problems.join('\n'), /unknown column "email"/);
    assert.match(parsed.problems.join('\n'), /"name" is given twice/);
    assert.match(parsed.problems.join('\n'), /missing required column "phone"/);
  });

  it('refuses an empty file and a header with no rows', () => {
    assert.deepEqual(parseRosterCsv('').problems, ['file: is empty']);
    assert.deepEqual(parseRosterCsv(`${HEADER}\n`).problems, [
      'file: has a header and no rows',
    ]);
  });

  it('reports malformed CSV by code and line, without quoting the cell', () => {
    const parsed = parseRosterCsv(`${HEADER}\nxabc12,Ana Lima\n`);

    assert.equal(parsed.problems.length, 1);
    assert.match(parsed.problems[0] ?? '', /^line 2: malformed CSV \(CSV_/);
    assert.doesNotMatch(parsed.problems[0] ?? '', /Ana/);
  });

  it('refuses a code given twice, naming both lines', () => {
    const parsed = parseRosterCsv(
      [HEADER, ANA, 'XABC12,Other Name,5511900005678,,,,'].join('\n'),
    );

    assert.deepEqual(parsed.problems, ['line 3 (xabc12): duplicate of line 2']);
  });

  it('refuses a volunteer key on a participant, and walk-in codes', () => {
    const parsed = parseRosterCsv(
      [
        HEADER,
        'vabc12,Ana Lima,5511900001234,participant,,,',
        'dabc12,Ana Lima,5511900001234,,,,',
      ].join('\n'),
    );

    assert.equal(parsed.rows.length, 0);
    assert.match(parsed.problems[0] ?? '', /^line 2: .*prefix/);
    assert.match(parsed.problems[1] ?? '', /^line 3 \(dabc12\): "d" codes/);
  });

  it('refuses a walk-in key with a participant or a blank role', () => {
    const parsed = parseRosterCsv(
      [
        HEADER,
        'dabc12,Ana Lima,5511900001234,participant,,,',
        'dabc13,Bruno Maia,5511900002222,,,,',
      ].join('\n'),
    );

    assert.equal(parsed.rows.length, 0);
    assert.match(parsed.problems.join('\n'), /line 2 \(dabc12\): "d" codes/);
    assert.match(parsed.problems.join('\n'), /line 3 \(dabc13\): "d" codes/);
  });

  it('refuses the hyphenated form and codes of the wrong length', () => {
    const parsed = parseRosterCsv(
      [
        HEADER,
        'x-abc12,Ana Lima,5511900001234,,,,',
        'x-abc1,Bruno Maia,5511900002222,,,,',
        'xabc1,Caio Reis,5511900003333,,,,',
        'xabc123,Dina Reis,5511900004444,,,,',
      ].join('\n'),
    );

    assert.equal(parsed.rows.length, 0);
    assert.equal(parsed.problems.length, 4);
  });

  it('accepts p and digit keys as ordinary participants', () => {
    const parsed = parseRosterCsv(
      [
        HEADER,
        'pabc12,Ana Lima,5511900001234,,,,',
        '7abc12,Bruno Maia,5511900002222,participant,,,',
      ].join('\n'),
    );

    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(
      parsed.rows.map((row) => [row.ticketCode, row.role]),
      [
        ['pabc12', 'participant'],
        ['7abc12', 'participant'],
      ],
    );
  });

  it('accepts another ticket source as a participant', () => {
    const parsed = parseRosterCsv(
      [
        HEADER,
        'xabc12,Ana Lima,5511900001234,,,,',
        'Yabc12,Bruno Maia,5511900002222,participant,,,',
      ].join('\n'),
    );

    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(
      parsed.rows.map((row) => [row.ticketCode, row.role]),
      [
        ['xabc12', 'participant'],
        ['yabc12', 'participant'],
      ],
    );
  });

  it('refuses a volunteer role on another ticket source', () => {
    const parsed = parseRosterCsv(
      [HEADER, 'xabc12,Ana Lima,5511900001234,volunteer,,,'].join('\n'),
    );

    assert.equal(parsed.rows.length, 0);
    assert.match(parsed.problems[0] ?? '', /^line 2: .*prefix/);
  });

  it('collects every problem on a row, without echoing names or phones', () => {
    const parsed = parseRosterCsv(`${HEADER}\nxabc12,1234,12,chef,,,`);

    assert.deepEqual(parsed.problems, [
      'line 2: Invalid role',
      'line 2: Invalid name',
      'line 2: Invalid phone',
    ]);

    const fields = parseRosterCsv(`${HEADER}\nxabc12,1234,12,,,,`);

    assert.deepEqual(fields.problems, [
      'line 2 (xabc12): Invalid name',
      'line 2 (xabc12): Invalid phone',
    ]);
  });

  it('warns on an off-list option and still loads it', () => {
    const parsed = parseRosterCsv(
      `${HEADER}\nxabc12,Ana Lima,5511900001234,,,,XXL`,
    );

    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.rows[0]?.fields.tshirt_size, 'XXL');
    assert.match(parsed.warnings[0] ?? '', /tshirt_size "XXL" is not on/);
  });

  it('warns on an option not approved for the row role', () => {
    const parsed = parseRosterCsv(
      `${LUNCH_HEADER}\nxabc12,Ana Lima,5511900001234,,,,,${LUNCH}`,
    );

    assert.match(parsed.warnings[0] ?? '', /lunch_option ".*" is not on/);
  });

  it('does not judge an option on a row whose role is invalid', () => {
    const parsed = parseRosterCsv(
      `${HEADER}\nxabc12,Ana Lima,5511900001234,admin,,,XXL`,
    );

    assert.equal(parsed.problems.length, 1);
    assert.deepEqual(parsed.warnings, []);
  });

  it('loads lunch on a volunteer', () => {
    const parsed = parseRosterCsv(
      `${LUNCH_HEADER}\nvabc12,Bruno Maia,5511900002222,,,,,${LUNCH}`,
    );

    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.rows[0]?.fields.lunch_option, LUNCH);
  });

  it('refuses lunch on a participant', () => {
    const parsed = parseRosterCsv(
      `${LUNCH_HEADER}\nxabc12,Ana Lima,5511900001234,,,,,${LUNCH}`,
    );

    assert.deepEqual(parsed.problems, [
      'line 2 (xabc12): lunch_option is for volunteers only',
    ]);
    assert.equal(parsed.rows.length, 0);
  });

  it('loads the volunteer t-shirt on a volunteer', () => {
    const parsed = parseRosterCsv(
      `${VOLUNTEER_TSHIRT_HEADER}\nvabc12,Bruno Maia,5511900002222,,,,,${VOLUNTEER_TSHIRT}`,
    );

    assert.deepEqual(parsed.problems, []);
    assert.equal(
      parsed.rows[0]?.fields.tshirt_volunteer_size,
      VOLUNTEER_TSHIRT,
    );
  });

  it('refuses the volunteer t-shirt on a participant', () => {
    const parsed = parseRosterCsv(
      `${VOLUNTEER_TSHIRT_HEADER}\nxabc12,Ana Lima,5511900001234,,,,,${VOLUNTEER_TSHIRT}`,
    );

    assert.deepEqual(parsed.problems, [
      'line 2 (xabc12): tshirt_volunteer_size is for volunteers only',
    ]);
    assert.equal(parsed.rows.length, 0);
  });

  it('reads team, role and check-in time on a volunteer', () => {
    const parsed = parseRosterCsv(
      `${TEAM_HEADER}\nvabc12,Bruno Maia,5511900002222,,,,,"  check-in  CREW ",lead  senior,8:30`,
    );

    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.rows[0]?.fields.team, 'check-in CREW');
    assert.equal(parsed.rows[0].fields.team_role, 'lead senior');
    assert.equal(parsed.rows[0].fields.checkin_time, '08:30');
  });

  it('reads blank cells under a present header as a clear', () => {
    const parsed = parseRosterCsv(
      `${TEAM_HEADER}\nvabc12,Bruno Maia,5511900002222,,,,,,,`,
    );

    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.rows[0]?.fields.team, null);
    assert.equal(parsed.rows[0].fields.team_role, null);
    assert.equal(parsed.rows[0].fields.checkin_time, null);
  });

  it('leaves the fields undefined when the header omits them', () => {
    const parsed = parseRosterCsv(
      `${HEADER}\nvabc12,Bruno Maia,5511900002222,,,,`,
    );

    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.rows[0]?.fields.team, undefined);
    assert.equal(parsed.rows[0]?.fields.team_role, undefined);
    assert.equal(parsed.rows[0]?.fields.checkin_time, undefined);
  });

  it('refuses a label over 40 characters and a malformed time', () => {
    const parsed = parseRosterCsv(
      `${TEAM_HEADER}\nvabc12,Bruno Maia,5511900002222,,,,,${'x'.repeat(41)},${'y'.repeat(41)},25:00`,
    );

    assert.deepEqual(parsed.problems, [
      'line 2 (vabc12): team must be at most 40 characters',
      'line 2 (vabc12): team_role must be at most 40 characters',
      'line 2 (vabc12): checkin_time must be a time as HH:MM',
    ]);
    assert.equal(parsed.rows.length, 0);
  });

  it('refuses team, role and check-in time on a participant', () => {
    const parsed = parseRosterCsv(
      `${TEAM_HEADER}\nxabc12,Ana Lima,5511900001234,,,,,Crew,Lead,08:30`,
    );

    assert.deepEqual(parsed.problems, [
      'line 2 (xabc12): team is for volunteers only',
      'line 2 (xabc12): team_role is for volunteers only',
      'line 2 (xabc12): checkin_time is for volunteers only',
    ]);
    assert.equal(parsed.rows.length, 0);
  });

  it('accepts blank team columns on a participant', () => {
    const parsed = parseRosterCsv(
      `${TEAM_HEADER}\nxabc12,Ana Lima,5511900001234,,,,,,,`,
    );

    assert.deepEqual(parsed.problems, []);
  });
});

/** Every prefix a spreadsheet may read as a formula, tab and CR included. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'] as const;

const FREE_TEXT_COLUMNS = [
  'name',
  'meal_option',
  'drink_option',
  'tshirt_size',
  'lunch_option',
  'tshirt_volunteer_size',
  'team',
  'team_role',
] as const;

const ALL_HEADER =
  'ticket_code,name,phone,role,meal_option,drink_option,tshirt_size,lunch_option,tshirt_volunteer_size,team,team_role,checkin_time';

/** A volunteer row with `value` in `column` and every other cell clean. */
const rowWith = (column: string, value: string): string => {
  const cells: Record<string, string> = {
    ticket_code: 'vabc12',
    name: 'Bruno Maia',
    phone: '5511900002222',
    role: 'volunteer',
    meal_option: '',
    drink_option: '',
    tshirt_size: '',
    lunch_option: '',
    tshirt_volunteer_size: '',
    team: '',
    team_role: '',
    checkin_time: '',
    [column]: value,
  };

  return ALL_HEADER.split(',')
    .map((name) => `"${(cells[name] ?? '').replaceAll('"', '""')}"`)
    .join(',');
};

describe('parseRosterCsv formula cells', () => {
  for (const column of FREE_TEXT_COLUMNS) {
    for (const prefix of FORMULA_PREFIXES) {
      it(`refuses ${JSON.stringify(prefix)} at the start of ${column}`, () => {
        const parsed = parseRosterCsv(
          `${ALL_HEADER}\n${rowWith(column, `${prefix}Ana`)}`,
        );

        assert.equal(parsed.rows.length, 0);
        assert.equal(parsed.problems.length, 1);
        assert.match(
          parsed.problems[0] ?? '',
          new RegExp(`^line \\d+ \\(vabc12\\): ${column} .*formula`),
        );
      });
    }
  }

  it('refuses a formula character left behind after trimming', () => {
    const parsed = parseRosterCsv(
      `${ALL_HEADER}\n${rowWith('meal_option', '  =1+1')}`,
    );

    assert.match(parsed.problems[0] ?? '', /meal_option .*formula/);
  });

  it('reports the line of each offending row', () => {
    const parsed = parseRosterCsv(
      [
        ALL_HEADER,
        rowWith('team', 'ok'),
        rowWith('name', '=cmd|x').replace('vabc12', 'vabc13'),
      ].join('\n'),
    );

    assert.equal(parsed.problems.length, 1);
    assert.match(parsed.problems[0] ?? '', /^line 3 \(vabc13\): name /);
  });

  it('still loads a phone that starts with +, and stores it with the +', () => {
    const rows = parseClean(
      'xabc12,Ana Lima,+55 (11) 90000-1234,,,,\nxabc13,Bia Lima,+44 7911 123456,,,,',
    );

    assert.equal(rows[0]?.fields.attendee_phone, '+5511900001234');
    assert.equal(rows[1]?.fields.attendee_phone, '+447911123456');
  });

  it('still loads a phone that starts with a hyphen or a tab', () => {
    const parsed = parseRosterCsv(
      `${HEADER}\nxabc12,Ana Lima,-5511900001234,,,,\nxabc13,Bia Lima,"\t5511900001235",,,,`,
    );

    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.rows.length, 2);
  });

  it('still loads a ticket_code and a time, which are shape-checked', () => {
    const rows = parseRosterCsv(
      `${ALL_HEADER}\n${rowWith('checkin_time', '8:30')}`,
    ).rows;

    assert.equal(rows[0]?.fields.checkin_time, '08:30');
  });

  for (const prefix of ['=', '+', '-', '@']) {
    it(`refuses ${prefix} at the start of ticket_code by its shape`, () => {
      const parsed = parseRosterCsv(
        `${ALL_HEADER}\n${rowWith('ticket_code', `${prefix}bc12`)}`,
      );

      assert.match(parsed.problems[0] ?? '', /^line 2: /);
      assert.equal(parsed.rows.length, 0);
    });
  }
});

describe('planImport', () => {
  it('inserts a code nobody holds', () => {
    const plan = planImport(parseClean(ANA), [], EVENT);

    assert.equal(plan.inserts.length, 1);
    assert.deepEqual(plan.problems, []);
  });

  it('leaves an identical row alone, whitespace differences included', () => {
    const rows = parseClean(`xabc12," Ana  Lima",5511900001234,,${MEAL},,`);
    const plan = planImport(rows, [existing()], EVENT);

    assert.equal(plan.unchanged, 1);
    assert.equal(plan.updates.length, 0);
    assert.equal(plan.inserts.length, 0);
  });

  it('updates only the fields that differ, and flags check-in', () => {
    const rows = parseClean(
      `xabc12,Ana Lima,5511900009999,,${MEAL},,${TSHIRT}`,
    );
    const plan = planImport(
      rows,
      [existing({ checkin_complete: true })],
      EVENT,
    );

    assert.equal(plan.updates.length, 1);
    assert.deepEqual(plan.updates[0]?.changed, [
      'attendee_phone',
      'tshirt_size',
    ]);
    assert.equal(plan.updates[0].checkedIn, true);
    assert.equal(plan.updates[0].attendeeId, 'id-abc12');
  });

  it('refuses a code another event holds, without naming it', () => {
    const plan = planImport(
      parseClean(ANA),
      [existing({ event_id: 'event-b' })],
      EVENT,
    );

    assert.equal(plan.inserts.length, 0);
    assert.deepEqual(plan.problems, [
      'line 2 (xabc12): code is already issued under another event',
    ]);
  });

  it('refuses a role change', () => {
    const plan = planImport(
      parseClean(ANA),
      [existing({ attendee_role: 'volunteer' })],
      EVENT,
    );

    assert.match(plan.problems[0] ?? '', /never changes a role/);
    assert.equal(plan.updates.length, 0);
  });

  it('refuses to clear an entitlement already collected', () => {
    const plan = planImport(
      parseClean('xabc12,Ana Lima,5511900001234,,,,'),
      [existing({ meal_redeemed_at: new Date() })],
      EVENT,
    );

    assert.match(plan.problems[0] ?? '', /meal_option is blank but the meal/);
  });

  it('refuses to clear a lunch already collected', () => {
    const plan = planImport(
      parseClean('vabc12,Bruno Maia,5511900002222,,,,'),
      [
        existing({
          ticket_code: 'vabc12',
          attendee_role: 'volunteer',
          attendee_name: 'Bruno Maia',
          attendee_phone: '5511900002222',
          meal_option: null,
          lunch_option: LUNCH,
          lunch_redeemed_at: new Date(),
        }),
      ],
      EVENT,
    );

    assert.match(plan.problems[0] ?? '', /lunch_option is blank but the lunch/);
  });

  it('refuses to clear a volunteer t-shirt already collected', () => {
    const plan = planImport(
      parseClean('vabc12,Bruno Maia,5511900002222,,,,'),
      [
        existing({
          ticket_code: 'vabc12',
          attendee_role: 'volunteer',
          attendee_name: 'Bruno Maia',
          attendee_phone: '5511900002222',
          meal_option: null,
          tshirt_volunteer_size: VOLUNTEER_TSHIRT,
          tshirt_volunteer_redeemed_at: new Date(),
        }),
      ],
      EVENT,
    );

    assert.match(
      plan.problems[0] ?? '',
      /tshirt_volunteer_size is blank but the tshirt_volunteer/,
    );
  });

  it('lists codes the roster dropped, but never walk-in or archived ones', () => {
    const plan = planImport(
      parseClean(ANA),
      [
        existing(),
        existing({ attendee_id: 'x1', ticket_code: 'xzzz99' }),
        existing({ attendee_id: 'x2', ticket_code: 'dwalk1' }),
        existing({
          attendee_id: 'x3',
          ticket_code: 'xold01',
          archived_at: new Date(),
        }),
        existing({ attendee_id: 'x4', ticket_code: 'xoth01', event_id: 'b' }),
      ],
      EVENT,
    );

    assert.deepEqual(plan.missing, ['xzzz99']);
  });

  it('lists a dropped code from another ticket source', () => {
    const plan = planImport(
      parseClean(ANA),
      [
        existing(),
        existing({ attendee_id: 'x1', ticket_code: 'xzzz99' }),
        existing({ attendee_id: 'x2', ticket_code: 'dwalk1' }),
      ],
      EVENT,
    );

    assert.deepEqual(plan.missing, ['xzzz99']);
  });
});

describe('planImport volunteer team fields', () => {
  const VOLUNTEER = `vabc12,Bruno Maia,5511900002222,,,,,Crew,Lead,08:30`;

  const volunteer = (
    overrides: Partial<ExistingAttendee> = {},
  ): ExistingAttendee =>
    existing({
      ticket_code: 'vabc12',
      attendee_role: 'volunteer',
      attendee_name: 'Bruno Maia',
      attendee_phone: '5511900002222',
      meal_option: null,
      team: 'Crew',
      team_role: 'Lead',
      checkin_time: '08:30:00',
      ...overrides,
    });

  const parseTeam = (line: string): RosterRow[] => {
    const parsed = parseRosterCsv(`${TEAM_HEADER}\n${line}`);

    assert.deepEqual(parsed.problems, []);

    return parsed.rows;
  };

  it('carries them on an insert', () => {
    const plan = planImport(parseTeam(VOLUNTEER), [], EVENT);

    assert.equal(plan.inserts[0]?.fields.team, 'Crew');
    assert.equal(plan.inserts[0].fields.team_role, 'Lead');
    assert.equal(plan.inserts[0].fields.checkin_time, '08:30');
  });

  it('compares a stored HH:MM:SS time on its minutes', () => {
    const plan = planImport(parseTeam(VOLUNTEER), [volunteer()], EVENT);

    assert.equal(plan.unchanged, 1);
    assert.deepEqual(plan.updates, []);
  });

  it('lists a changed team', () => {
    const plan = planImport(
      parseTeam(VOLUNTEER),
      [volunteer({ team: 'Kitchen' })],
      EVENT,
    );

    assert.deepEqual(plan.updates[0]?.changed, ['team']);
  });

  it('lists a changed check-in time', () => {
    const plan = planImport(
      parseTeam(VOLUNTEER),
      [volunteer({ checkin_time: '09:00:00' })],
      EVENT,
    );

    assert.deepEqual(plan.updates[0]?.changed, ['checkin_time']);
  });

  it('clears a stored value under a blank cell', () => {
    const plan = planImport(
      parseTeam('vabc12,Bruno Maia,5511900002222,,,,,,,'),
      [volunteer()],
      EVENT,
    );

    assert.deepEqual(plan.updates[0]?.changed, [
      'team',
      'team_role',
      'checkin_time',
    ]);
  });

  it('leaves stored values alone when the header omits the columns', () => {
    const parsed = parseRosterCsv(
      `${HEADER}\nvabc12,Bruno Maia,5511900002222,,,,`,
    );
    const plan = planImport(parsed.rows, [volunteer()], EVENT);

    assert.equal(plan.unchanged, 1);
    assert.deepEqual(plan.updates, []);
  });
});
