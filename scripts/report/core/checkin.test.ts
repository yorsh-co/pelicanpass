import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ITEM_LABELS, normaliseItem, parseCheckin } from './checkin.ts';

const HEADER =
  'ticket_code,attendee_role,checkin_complete,checkin_number,checkin_at,' +
  'meal_option,meal_redeemed_at,drink_option,drink_redeemed_at,tshirt_size,' +
  'tshirt_redeemed_at,lunch_option,lunch_redeemed_at,tshirt_volunteer_size,' +
  'tshirt_volunteer_redeemed_at,archived_at';

const withoutCode = (csv: string): string =>
  csv
    .split('\n')
    .map((line) => line.slice(line.indexOf(',') + 1))
    .join('\n');

const FIRST =
  'SECRET1,participant,t,1,2026-10-18 14:03:22.123456-03,"Lanche, queijo",' +
  '2026-10-18 15:00:00-03,,,M,,,,,,';
const SECOND = 'D0042,volunteer,f,,,,,,,,,,,,,2026-10-18 10:00:00+00';

describe('parseCheckin', () => {
  it('reads attendees and never keeps the ticket code', () => {
    const rows = parseCheckin(`${HEADER}\n${FIRST}\n${SECOND}\n`);

    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      role: 'participant',
      walkIn: false,
      church: null,
      ageDetail: null,
      saleDate: null,
      checkedIn: true,
      checkinAt: Date.parse('2026-10-18T17:03:22.123Z'),
      archived: false,
      items: {
        meal: {
          option: 'Lanche, queijo',
          redeemedAt: Date.parse('2026-10-18T18:00:00Z'),
        },
        drink: { option: null, redeemedAt: null },
        tshirt: { option: 'M', redeemedAt: null },
        lunch: { option: null, redeemedAt: null },
        tshirtVolunteer: { option: null, redeemedAt: null },
      },
    });
    assert.deepEqual(
      rows.slice(1).map((r) => [r.walkIn, r.archived, r.checkedIn]),
      [[true, true, false]],
    );

    const serialised = JSON.stringify(rows).toLowerCase();

    assert.ok(!serialised.includes('secret1'));
    assert.ok(!serialised.includes('d0042'));
  });

  it('leaves walkIn null when ticket_code is absent', () => {
    const rows = parseCheckin(withoutCode(`${HEADER}\n${FIRST}\n${SECOND}\n`));

    assert.deepEqual(
      rows.map((r) => r.walkIn),
      [null, null],
    );
  });

  it('derives walkIn from a guarded, lower-case code', () => {
    const row = "'-d1,participant,f,,,,,,,,,,,,,,";
    const [a, b] = parseCheckin(
      `${HEADER}\n${row}\n'=x,participant,f,,,,,,,,,,,,,,\n`,
    );

    assert.equal(a?.walkIn, false);
    assert.equal(b?.walkIn, false);
    assert.equal(
      parseCheckin(`${HEADER}\nd9,participant,f,,,,,,,,,,,,,,\n`)[0]?.walkIn,
      true,
    );
    assert.equal(
      parseCheckin(`${HEADER}\n,participant,f,,,,,,,,,,,,,,\n`)[0]?.walkIn,
      null,
    );
  });

  it('strips the formula guard from text cells', () => {
    const row = "x,participant,f,,,'=cmd,,'-x,,'@L,,,,,,";
    const [a] = parseCheckin(`${HEADER}\n${row}\n`);

    assert.deepEqual(
      a && [a.items.meal.option, a.items.drink.option, a.items.tshirt.option],
      ['=cmd', '-x', '@L'],
    );
  });

  it('reads the optional church column in any position', () => {
    const csv = `church,${HEADER}\n  Batista  ,x,participant,f,,,,,,,,,,,,,,\n,x,participant,f,,,,,,,,,,,,,,\n`;
    const rows = parseCheckin(csv);

    assert.deepEqual(
      rows.map((r) => r.church),
      ['Batista', null],
    );
  });

  it('treats a whitespace-only church as unknown', () => {
    const csv = `church,${HEADER}\n   ,x,participant,f,,,,,,,,,,,,,,\n`;

    assert.equal(parseCheckin(csv)[0]?.church, null);
  });

  describe('age column', () => {
    const AGE_HEADER = `age,${HEADER}`;
    const rowWith = (age: string): string =>
      `${AGE_HEADER}\n${age},x,participant,f,,,,,,,,,,,,,,\n`;
    const bands = (...ages: string[]): (string | null)[] =>
      parseCheckin(
        `${AGE_HEADER}\n${ages.map((a) => `${a},x,volunteer,f,,,,,,,,,,,,,,`).join('\n')}\n`,
      ).map((r) => r.ageDetail);

    it('maps ages to detail groups, trimming blanks', () => {
      assert.deepEqual(
        bands('0', '7', ' 12 ', '13', '18', '19', '120', '013'),
        ['≤12', '≤12', '≤12', '13', '18', '19+', '19+', '13'],
      );
    });

    it('is null when blank or when the column is absent', () => {
      assert.deepEqual(bands('', '   '), [null, null]);
      assert.equal(parseCheckin(`${HEADER}\n${FIRST}\n`)[0]?.ageDetail, null);
    });

    it('rejects non-whole, negative, implausible and guarded ages', () => {
      for (const bad of [
        'abc',
        '15.5',
        '-1',
        '121',
        '1000',
        '1e1',
        "'-1",
        "'+15",
      ]) {
        assert.throws(
          () => parseCheckin(rowWith(bad)),
          /coluna age, linha 2/,
          bad,
        );
      }
    });

    it('keeps no numeric age and collapses ages outside 13 to 18', () => {
      const [teen] = parseCheckin(rowWith('17'));
      const [child] = parseCheckin(rowWith('7'));
      const [adult] = parseCheckin(rowWith('42'));

      assert.equal(teen?.ageDetail, '17');
      assert.equal(child?.ageDetail, '≤12');
      assert.equal(adult?.ageDetail, '19+');
      for (const row of [teen, child, adult]) {
        assert.deepEqual(
          Object.keys(row as object).filter((key) => /age/i.test(key)),
          ['ageDetail'],
        );
        assert.equal(typeof row.ageDetail, 'string');
      }
    });
  });

  it('reads timestamp offset variants', () => {
    const t = (stamp: string): number | null =>
      parseCheckin(`${HEADER}\nx,participant,t,1,${stamp},,,,,,,,,,,\n`)[0]
        ?.checkinAt ?? null;
    const expected = Date.parse('2026-10-18T17:00:00Z');

    assert.equal(t('2026-10-18 14:00:00-03'), expected);
    assert.equal(t('2026-10-18 14:00:00-03:00'), expected);
    assert.equal(t('2026-10-18T17:00:00Z'), expected);
    assert.equal(t('2026-10-18 17:00:00+00'), expected);
    assert.equal(t('2026-10-18 22:30:00+05:30'), expected);
    assert.equal(t('2026-10-18 17:00:00.5+00'), expected + 500);
  });

  it('names the missing required columns in pt-BR', () => {
    assert.throws(
      () => parseCheckin('attendee_role,checkin_at\nparticipant,\n'),
      (error: Error) =>
        error.message.startsWith('Arquivo de check-in inválido: faltam') &&
        error.message.includes('checkin_complete') &&
        error.message.includes('archived_at') &&
        !error.message.includes('ticket_code') &&
        !error.message.includes('church'),
    );
  });

  it('rejects unreadable cells with the line number', () => {
    assert.throws(
      () => parseCheckin(`${HEADER}\nx,boss,f,,,,,,,,,,,,,,\n`),
      /attendee_role, linha 2/,
    );
    assert.throws(
      () => parseCheckin(`${HEADER}\nx,participant,t,1,ontem,,,,,,,,,,,\n`),
      /checkin_at, linha 2/,
    );
  });

  it('labels the items in pt-BR', () => {
    assert.equal(ITEM_LABELS.tshirtVolunteer, 'Camiseta de voluntário');
    assert.equal(ITEM_LABELS.lunch, 'Almoço');
  });

  describe('sale_date column', () => {
    const SALE_HEADER = `sale_date,${HEADER}`;
    const dates = (...cells: string[]): (string | null)[] =>
      parseCheckin(
        `${SALE_HEADER}\n${cells.map((c) => `${c},x,participant,f,,,,,,,,,,,,,,`).join('\n')}\n`,
      ).map((r) => r.saleDate);

    it('reads both formats and drops the time', () => {
      assert.deepEqual(
        dates(
          '2026-03-05',
          '05/03/2026',
          '2026-03-05 14:30:00',
          '2026-03-05T14:30:00-03:00',
          '05/03/2026 09:00',
          ' 2024-02-29 ',
        ),
        [
          '2026-03-05',
          '2026-03-05',
          '2026-03-05',
          '2026-03-05',
          '2026-03-05',
          '2024-02-29',
        ],
      );
    });

    it('is null when blank or when the column is absent', () => {
      assert.deepEqual(dates('', '   '), [null, null]);
      assert.equal(parseCheckin(`${HEADER}\n${FIRST}\n`)[0]?.saleDate, null);
    });

    it('reads volunteers too', () => {
      const csv = `${SALE_HEADER}\n2026-03-05,x,volunteer,f,,,,,,,,,,,,,,\n`;

      assert.equal(parseCheckin(csv)[0]?.saleDate, '2026-03-05');
    });

    it('rejects invalid dates with the column and line', () => {
      for (const bad of [
        '2026-02-30',
        '31/04/2026',
        'abc',
        '2026-13-01',
        '2026-00-10',
        '2025-02-29',
        '2026-03-05x',
        '2026-3-5',
        '05-03-2026',
      ]) {
        assert.throws(
          () => dates('2026-03-05', bad),
          /coluna sale_date, linha 3/,
          bad,
        );
      }
    });
  });
});

describe('normaliseItem', () => {
  it('keeps a known item key', () => {
    assert.equal(normaliseItem('drink'), 'drink');
  });

  it('drops an unknown string', () => {
    assert.equal(normaliseItem('pizza'), null);
  });

  it('drops values that are not strings', () => {
    assert.equal(normaliseItem(3), null);
    assert.equal(normaliseItem(null), null);
    assert.equal(normaliseItem(undefined), null);
  });
});
