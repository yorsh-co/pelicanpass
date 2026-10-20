import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parsePermissionsCsv,
  planPermissions,
} from './admin.volunteer-permissions.import.ts';

import type {
  ExistingVolunteer,
  KnownAdmins,
  PermissionRow,
} from './admin.volunteer-permissions.import.ts';

const EVENT = 'event-a';
const HEADER = 'ticket_code,can_redeem,redeem_scopes,can_draw';

/**
 * Parses a file built from the given header and lines, and asserts it produced
 * no problems.
 */
const parseClean = (header: string, ...lines: string[]): PermissionRow[] => {
  const parsed = parsePermissionsCsv([header, ...lines].join('\n'));

  assert.deepEqual(parsed.problems, []);

  return parsed.rows;
};

/** Problems from parsing a file built from the given header and lines. */
const problemsOf = (header: string, ...lines: string[]): string[] =>
  parsePermissionsCsv([header, ...lines].join('\n')).problems;

/** An existing volunteer `vabc12` holding nothing. */
const existing = (
  overrides: Partial<ExistingVolunteer> = {},
): ExistingVolunteer => ({
  attendee_id: 'id-vabc12',
  event_id: EVENT,
  ticket_code: 'vabc12',
  attendee_role: 'volunteer',
  archived_at: null,
  can_redeem: false,
  redeem_scopes: ['tshirt', 'meal', 'drink'],
  can_draw: false,
  show_admin_link: false,
  admin_username: null,
  ...overrides,
});

/** Administrator accounts the plans below resolve usernames against. */
const ADMINS: KnownAdmins = new Map([
  ['consulta.ana', { isActive: true }],
  ['maria@example.com', { isActive: true }],
  ['retired', { isActive: false }],
]);

/** Plans the given lines against the given rows. */
const plan = (
  rows: ExistingVolunteer[],
  header: string,
  ...lines: string[]
): ReturnType<typeof planPermissions> =>
  planPermissions(parseClean(header, ...lines), rows, EVENT, ADMINS);

describe('parsePermissionsCsv', () => {
  it('reads every column, normalising case and scope order', () => {
    const [row] = parseClean(HEADER, 'VABC12,TRUE,Drink; tshirt,False');

    assert.equal(row?.ticketCode, 'vabc12');
    assert.deepEqual(row.values, {
      can_redeem: true,
      redeem_scopes: ['tshirt', 'drink'],
      can_draw: false,
    });
  });

  it('reads lunch as a scope, in item order', () => {
    const [row] = parseClean(HEADER, 'vabc12,true,lunch;meal,false');

    assert.deepEqual(row?.values.redeem_scopes, ['lunch', 'meal']);
  });

  it('reads the volunteer t-shirt as a scope, in item order', () => {
    const [row] = parseClean(
      HEADER,
      'vabc12,true,meal;tshirt_volunteer;tshirt,false',
    );

    assert.deepEqual(row?.values.redeem_scopes, [
      'tshirt_volunteer',
      'tshirt',
      'meal',
    ]);
  });

  it('reads "none" as an empty scope list', () => {
    const [row] = parseClean(HEADER, 'vabc12,true,none,false');

    assert.deepEqual(row?.values.redeem_scopes, []);
  });

  it('holds only the columns the header names', () => {
    const [row] = parseClean('can_draw,Ticket_Code', 'true,vabc12');

    assert.deepEqual(row?.values, { can_draw: true });
  });

  it('reads show_admin_link on its own', () => {
    const [row] = parseClean('ticket_code,show_admin_link', 'vabc12,TRUE');

    assert.deepEqual(row?.values, { show_admin_link: true });
  });

  it('refuses a blank or non-boolean show_admin_link', () => {
    assert.deepEqual(
      problemsOf('ticket_code,show_admin_link', 'vabc12,', 'vabc13,yes'),
      [
        'line 2 (vabc12): show_admin_link must be true or false',
        'line 3 (vabc13): show_admin_link must be true or false',
      ],
    );
  });

  it('reads admin_username lowercased and trimmed', () => {
    const [row] = parseClean(
      'ticket_code,admin_username',
      'vabc12,  Maria@Example.COM ',
    );

    assert.deepEqual(row?.values, { admin_username: 'maria@example.com' });
  });

  it('reads a blank admin_username as a clear', () => {
    const [row] = parseClean('ticket_code,admin_username', 'vabc12,');

    assert.deepEqual(row?.values, { admin_username: null });
  });

  it('refuses a malformed admin_username', () => {
    assert.deepEqual(
      problemsOf(
        'ticket_code,admin_username',
        'vabc12,ab',
        'vabc13,has space',
        'vabc14,a@b',
        `vabc15,${'x'.repeat(65)}`,
      ),
      [
        'line 2 (vabc12): admin_username is not a valid administrator username',
        'line 3 (vabc13): admin_username is not a valid administrator username',
        'line 4 (vabc14): admin_username is not a valid administrator username',
        'line 5 (vabc15): admin_username is not a valid administrator username',
      ],
    );
  });

  it('refuses unknown, repeated and missing headers', () => {
    assert.match(
      problemsOf('ticket_code,can_redeem,name', 'vabc12,true,x').join(),
      /unknown column "name"/,
    );
    assert.match(
      problemsOf('ticket_code,can_draw,can_draw', 'vabc12,true,true').join(),
      /"can_draw" is given twice/,
    );
    assert.match(
      problemsOf('can_redeem', 'true').join(),
      /missing required column "ticket_code"/,
    );
    assert.match(
      problemsOf('ticket_code', 'vabc12').join(),
      /names no permission column/,
    );
  });

  it('says where team, team_role and checkin_time went', () => {
    for (const column of ['team', 'team_role', 'checkin_time']) {
      assert.deepEqual(
        problemsOf(`ticket_code,can_draw,${column}`, 'vabc12,true,x'),
        [
          `header: "${column}" is loaded by the roster import (import-attendees.ts), not this file`,
        ],
      );
    }
  });

  it('keeps the column list for any other unknown column', () => {
    assert.match(
      problemsOf('ticket_code,can_draw,name', 'vabc12,true,x').join(),
      /unknown column "name"; columns are ticket_code,/,
    );
  });

  it('refuses an empty file and a header with no rows', () => {
    assert.deepEqual(parsePermissionsCsv('').problems, ['file: is empty']);
    assert.deepEqual(problemsOf(HEADER), ['file: has a header and no rows']);
  });

  it('refuses blank and malformed cells, naming the line and code', () => {
    const problems = problemsOf(
      HEADER,
      'vabc12,,tshirt,false',
      'vabc13,true,,false',
      'vabc14,yes,tshirt,false',
      'vabc15,true,hat,false',
      'vabc16,true,meal;meal,false',
      'vabc17,true,meal;,false',
    );

    assert.deepEqual(problems, [
      'line 2 (vabc12): can_redeem must be true or false',
      'line 3 (vabc13): redeem_scopes is blank; use tshirt_volunteer, lunch, tshirt, meal, drink or none',
      'line 4 (vabc14): can_redeem must be true or false',
      'line 5 (vabc15): redeem_scopes "hat" is not one of tshirt_volunteer, lunch, tshirt, meal, drink or none',
      'line 6 (vabc16): redeem_scopes lists an item twice',
      'line 7 (vabc17): redeem_scopes "" is not one of tshirt_volunteer, lunch, tshirt, meal, drink or none',
    ]);
  });

  it('refuses participant codes, malformed codes and duplicates', () => {
    const problems = problemsOf(
      'ticket_code,can_draw',
      'xabc12,true',
      'vab,true',
      'vabc12,true',
      'vabc12,false',
      'v-abc12,true',
    );

    assert.deepEqual(problems, [
      'line 2: ticket_code is not a volunteer code',
      'line 3: ticket_code is not a volunteer code',
      'line 5 (vabc12): duplicate of line 4',
      'line 6: ticket_code is not a volunteer code',
    ]);
  });
});

describe('parsePermissionsCsv formula cells', () => {
  const FULL = 'ticket_code,can_redeem,redeem_scopes,can_draw,admin_username';

  for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
    for (const column of [
      'ticket_code',
      'can_redeem',
      'redeem_scopes',
      'can_draw',
    ]) {
      it(`refuses ${JSON.stringify(prefix)} at the start of ${column}`, () => {
        const cells: Record<string, string> = {
          ticket_code: 'vabc12',
          can_redeem: 'true',
          redeem_scopes: 'meal',
          can_draw: 'false',
          admin_username: '',
        };

        cells[column] = `${prefix}1+1`;

        const problems = problemsOf(
          FULL,
          Object.values(cells)
            .map((cell) => `"${cell}"`)
            .join(','),
        );

        assert.equal(problems.length, 1);
        assert.match(problems[0] ?? '', new RegExp(`^line \\d+.*${column}`));
      });
    }
  }

  for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
    it(`refuses ${JSON.stringify(prefix)} at the start of admin_username`, () => {
      const problems = problemsOf(
        FULL,
        `vabc12,true,meal,false,"${prefix}cmd"`,
      );

      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? '', /^line \d+ .*admin_username/);
    });
  }
});

describe('planPermissions', () => {
  it('writes only the changed columns', () => {
    const result = plan([existing()], HEADER, 'vabc12,true,meal;drink,false');

    assert.deepEqual(result.problems, []);
    assert.equal(result.updates.length, 1);
    assert.deepEqual(result.updates[0]?.changed, [
      'can_redeem',
      'redeem_scopes',
    ]);
    assert.equal(result.updates[0].attendeeId, 'id-vabc12');
    assert.deepEqual(result.updates[0].before, {
      can_redeem: false,
      redeem_scopes: ['tshirt', 'meal', 'drink'],
      can_draw: false,
      show_admin_link: false,
      admin_username: null,
    });
  });

  it('counts a row matching what is stored as unchanged, whatever the scope order', () => {
    const result = plan(
      [existing({ can_redeem: true, redeem_scopes: ['drink', 'meal'] })],
      HEADER,
      'vabc12,true,meal;drink,false',
    );

    assert.deepEqual(result.updates, []);
    assert.equal(result.unchanged, 1);
  });

  it('never writes a column the header leaves out', () => {
    const result = plan(
      [existing({ can_redeem: true, redeem_scopes: ['meal'] })],
      'ticket_code,can_draw',
      'vabc12,true',
    );

    assert.deepEqual(result.updates[0]?.changed, ['can_draw']);
    assert.equal(result.updates[0].revoked, false);
  });

  it('flags a flag turned off or a scope dropped as revoked', () => {
    const held = existing({
      can_redeem: true,
      redeem_scopes: ['tshirt', 'meal'],
      can_draw: true,
    });

    assert.equal(
      plan([held], 'ticket_code,can_redeem', 'vabc12,false').updates[0]
        ?.revoked,
      true,
    );
    assert.equal(
      plan([held], 'ticket_code,can_draw', 'vabc12,false').updates[0]?.revoked,
      true,
    );
    assert.equal(
      plan([held], 'ticket_code,redeem_scopes', 'vabc12,meal;drink').updates[0]
        ?.revoked,
      true,
    );
    assert.equal(
      plan([held], 'ticket_code,redeem_scopes', 'vabc12,tshirt;meal;drink')
        .updates[0]?.revoked,
      false,
    );
  });

  it('writes show_admin_link without counting its removal as revoked', () => {
    const granted = plan(
      [existing()],
      'ticket_code,show_admin_link',
      'vabc12,true',
    );

    assert.deepEqual(granted.updates[0]?.changed, ['show_admin_link']);

    const cleared = plan(
      [existing({ show_admin_link: true })],
      'ticket_code,show_admin_link',
      'vabc12,false',
    );

    assert.deepEqual(cleared.updates[0]?.changed, ['show_admin_link']);
    assert.equal(cleared.updates[0].revoked, false);
  });

  it('writes a known admin_username without counting it as revoked', () => {
    const result = plan(
      [existing()],
      'ticket_code,admin_username',
      'vabc12,CONSULTA.ANA',
    );

    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.updates[0]?.changed, ['admin_username']);
    assert.equal(result.updates[0].row.values.admin_username, 'consulta.ana');
    assert.equal(result.updates[0].revoked, false);
  });

  it('refuses an admin_username no administrator holds', () => {
    const result = plan(
      [existing()],
      'ticket_code,admin_username',
      'vabc12,nobody',
    );

    assert.deepEqual(result.problems, [
      'line 2 (vabc12): admin_username matches no administrator',
    ]);
    assert.deepEqual(result.updates, []);
  });

  it('accepts a disabled administrator with a warning', () => {
    const result = plan(
      [existing()],
      'ticket_code,admin_username',
      'vabc12,retired',
    );

    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, [
      'line 2 (vabc12): administrator account is disabled',
    ]);
    assert.deepEqual(result.updates[0]?.changed, ['admin_username']);
  });

  it('clears admin_username on a blank cell without consulting admins', () => {
    const result = plan(
      [existing({ admin_username: 'gone' })],
      'ticket_code,admin_username',
      'vabc12,',
    );

    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.updates[0]?.changed, ['admin_username']);
    assert.equal(result.updates[0].row.values.admin_username, null);
  });

  it('counts an unchanged admin_username as unchanged', () => {
    const result = plan(
      [existing({ admin_username: 'consulta.ana' })],
      'ticket_code,admin_username',
      'vabc12,consulta.ana',
    );

    assert.deepEqual(result.updates, []);
    assert.equal(result.unchanged, 1);
  });

  it('leaves admin_username alone when the header omits it', () => {
    const result = plan(
      [existing({ admin_username: 'gone' })],
      'ticket_code,can_draw',
      'vabc12,true',
    );

    assert.deepEqual(result.updates[0]?.changed, ['can_draw']);
    assert.equal('admin_username' in result.updates[0].row.values, false);
    assert.deepEqual(result.warnings, []);
  });

  it('refuses admin_username for a participant', () => {
    const result = plan(
      [existing({ attendee_role: 'participant' })],
      'ticket_code,admin_username',
      'vabc12,consulta.ana',
    );

    assert.deepEqual(result.problems, ['line 2 (vabc12): is not a volunteer']);
  });

  it('ignores scopes narrowed while can_redeem is off', () => {
    const result = plan([existing()], HEADER, 'vabc12,true,meal;drink,true');

    assert.equal(result.updates[0]?.revoked, false);
  });

  it('writes an archived volunteer and flags it', () => {
    const result = plan(
      [existing({ archived_at: new Date() })],
      'ticket_code,can_draw',
      'vabc12,true',
    );

    assert.equal(result.updates[0]?.archived, true);
  });

  it('refuses show_admin_link for a participant', () => {
    const result = plan(
      [existing({ attendee_role: 'participant' })],
      'ticket_code,show_admin_link',
      'vabc12,true',
    );

    assert.deepEqual(result.problems, ['line 2 (vabc12): is not a volunteer']);
  });

  it('refuses an unknown code, another event and a non-volunteer', () => {
    const result = plan(
      [
        existing({ ticket_code: 'vabc13', event_id: 'event-b' }),
        existing({ ticket_code: 'vabc14', attendee_role: 'participant' }),
      ],
      'ticket_code,can_draw',
      'vabc12,true',
      'vabc13,true',
      'vabc14,true',
    );

    assert.deepEqual(result.problems, [
      'line 2 (vabc12): no attendee holds this code',
      'line 3 (vabc13): code is issued under another event',
      'line 4 (vabc14): is not a volunteer',
    ]);
    assert.deepEqual(result.updates, []);
  });
});
