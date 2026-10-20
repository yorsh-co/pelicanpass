import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ageBandOf } from './age.ts';
import {
  activeRoles,
  applyFilters,
  churchSelectionLabel,
  DEFAULT_FILTERS,
  excludeAllBut,
  excludesVolunteers,
  ignoredBySurveys,
  isChurchFilterDefault,
  isDefaultFilters,
  NO_FILTERS,
  normaliseExcludedChurches,
  STAFF_CHURCH,
  toggleChurch,
} from './filter.ts';

import type { Attendee } from './checkin.ts';

const none = { option: null, redeemedAt: null };
const person = (over: Partial<Attendee>): Attendee => ({
  role: 'participant',
  walkIn: false,
  church: null,
  ageDetail: null,
  saleDate: null,
  checkedIn: false,
  checkinAt: null,
  archived: false,
  items: {
    meal: none,
    drink: none,
    tshirt: none,
    lunch: none,
    tshirtVolunteer: none,
  },
  ...over,
});

const everyone = [
  person({ church: 'A', ageDetail: '15' }),
  person({ church: 'B', walkIn: true, ageDetail: '15' }),
  person({ church: null }),
  person({ role: 'volunteer', walkIn: null, ageDetail: '19+' }),
];

describe('applyFilters', () => {
  it('keeps everyone without filters', () => {
    assert.equal(applyFilters(everyone, NO_FILTERS).length, 4);
  });

  it('filters by audience', () => {
    assert.equal(
      applyFilters(everyone, { ...NO_FILTERS, audience: 'volunteer' }).length,
      1,
    );
  });

  it('drops participants of excluded churches but keeps volunteers', () => {
    const filters = { ...NO_FILTERS, excludedChurches: ['A'] };

    assert.equal(excludesVolunteers(filters), false);
    assert.deepEqual(activeRoles(filters), ['participant', 'volunteer']);
    assert.equal(applyFilters(everyone, filters).length, 3);
    assert.equal(
      applyFilters(everyone, filters).filter((a) => a.role === 'volunteer')
        .length,
      1,
    );
  });

  it('matches excluded churches ignoring case and spacing', () => {
    const rows = applyFilters(
      [person({ church: '  CONVIDADO ' }), person({ church: 'A' })],
      { ...NO_FILTERS, excludedChurches: [STAFF_CHURCH] },
    );

    assert.deepEqual(
      rows.map((a) => a.church),
      ['A'],
    );
  });

  it('excludes blank churches by the unknown label', () => {
    const rows = applyFilters(everyone, {
      ...NO_FILTERS,
      excludedChurches: ['Não informada'],
    });

    assert.equal(rows.length, 3);
    assert.ok(rows.every((a) => a.role === 'volunteer' || a.church !== null));
  });

  it('excludes the staff by default', () => {
    const rows = applyFilters(
      [
        person({ church: STAFF_CHURCH }),
        person({ church: 'A' }),
        person({ role: 'volunteer', walkIn: null }),
      ],
      { ...DEFAULT_FILTERS, audience: 'all' },
    );

    assert.equal(rows.length, 2);
    assert.ok(rows.every((a) => a.church !== STAFF_CHURCH));
  });

  it('drops volunteers and matches the band under an age filter', () => {
    const filters = { ...NO_FILTERS, age: ['13–18'] } as const;

    assert.equal(excludesVolunteers(filters), true);
    assert.deepEqual(activeRoles(filters), ['participant']);
    assert.equal(applyFilters(everyone, filters).length, 2);
  });

  it('keeps participants in any of several selected bands', () => {
    const filters = { ...NO_FILTERS, age: ['≤12', '19+'] } as const;
    const rows = applyFilters(
      [
        person({ ageDetail: '≤12' }),
        person({ ageDetail: '19+' }),
        person({ ageDetail: '15' }),
        person({ ageDetail: null }),
      ],
      filters,
    );

    assert.deepEqual(rows.map(ageBandOf), ['≤12', '19+']);
  });

  it('combines bands with the unknown choice', () => {
    const rows = applyFilters(everyone, {
      ...NO_FILTERS,
      age: ['13–18', 'Não informada'],
    });

    assert.equal(rows.length, 3);
  });

  it('does not exclude volunteers on an empty age list', () => {
    assert.equal(excludesVolunteers(NO_FILTERS), false);
    assert.equal(
      excludesVolunteers({ ...NO_FILTERS, age: ['≤12', '13–18'] }),
      true,
    );
  });

  it('matches blank ages by the unknown label', () => {
    const rows = applyFilters(everyone, {
      ...NO_FILTERS,
      age: ['Não informada'],
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.church, null);
  });

  it('filters by how the ticket was bought', () => {
    assert.equal(
      applyFilters(everyone, { ...NO_FILTERS, ticket: 'walkIn' }).length,
      1,
    );
    assert.equal(
      applyFilters(everyone, { ...NO_FILTERS, ticket: 'preSale' }).length,
      2,
    );
  });

  it('shows no one for volunteers under a participant-only filter', () => {
    const filters = {
      audience: 'volunteer',
      excludedChurches: [],
      age: ['13–18'],
      ticket: 'all',
    } as const;

    assert.deepEqual(activeRoles(filters), []);
    assert.equal(applyFilters(everyone, filters).length, 0);
  });
});

describe('isDefaultFilters', () => {
  it('holds for participants of every age with no church or ticket filter', () => {
    assert.equal(isDefaultFilters(DEFAULT_FILTERS), true);
    assert.equal(DEFAULT_FILTERS.audience, 'participant');
    assert.deepEqual(DEFAULT_FILTERS.age, []);
  });

  it('compares church exclusions by key, ignoring order', () => {
    assert.equal(
      isDefaultFilters({
        ...DEFAULT_FILTERS,
        excludedChurches: ['  convidado'],
      }),
      true,
    );
  });

  it('fails once anything differs from the default', () => {
    assert.equal(isDefaultFilters(NO_FILTERS), false);
    assert.equal(
      isDefaultFilters({ ...DEFAULT_FILTERS, excludedChurches: ['A'] }),
      false,
    );
    assert.equal(
      isDefaultFilters({ ...DEFAULT_FILTERS, age: ['13–18'] }),
      false,
    );
    assert.equal(
      isDefaultFilters({ ...DEFAULT_FILTERS, ticket: 'walkIn' }),
      false,
    );
  });
});

describe('isChurchFilterDefault', () => {
  it('holds for the default exclusions, in any case or order', () => {
    assert.equal(isChurchFilterDefault(DEFAULT_FILTERS), true);
    assert.equal(
      isChurchFilterDefault({
        ...NO_FILTERS,
        excludedChurches: ['  CONVIDADO', 'convidado'],
      }),
      true,
    );
  });

  it('fails when churches are added or removed', () => {
    assert.equal(isChurchFilterDefault(NO_FILTERS), false);
    assert.equal(
      isChurchFilterDefault({
        ...NO_FILTERS,
        excludedChurches: [STAFF_CHURCH, 'A'],
      }),
      false,
    );
  });
});

describe('toggleChurch', () => {
  it('adds a church in pt-BR order', () => {
    assert.deepEqual(toggleChurch(['Zeta', 'Beta'], 'Álamo'), [
      'Álamo',
      'Beta',
      'Zeta',
    ]);
  });

  it('removes every stored variant of the same key', () => {
    assert.deepEqual(toggleChurch(['A', ' b ', 'B'], 'b'), ['A']);
  });

  it('never repeats a key', () => {
    assert.deepEqual(toggleChurch(['a', 'A'], 'C'), ['a', 'C']);
  });
});

describe('excludeAllBut', () => {
  it('excludes every name but those kept, by key', () => {
    assert.deepEqual(excludeAllBut(['B', 'A', 'C'], [' a ']), ['B', 'C']);
    assert.deepEqual(excludeAllBut(['A'], ['A']), []);
  });
});

describe('normaliseExcludedChurches', () => {
  it('trims, drops blanks and junk, and de-duplicates by key', () => {
    assert.deepEqual(
      normaliseExcludedChurches([' B ', 'a', 'A', '', '  ', 3, null]),
      ['a', 'B'],
    );
  });

  it('keeps an explicitly empty list', () => {
    assert.deepEqual(normaliseExcludedChurches([]), []);
  });

  it('falls back to the default for anything but an array', () => {
    for (const value of [undefined, null, 'Igreja Exemplo A', 7, {}]) {
      assert.deepEqual(normaliseExcludedChurches(value), [STAFF_CHURCH]);
    }
  });
});

describe('churchSelectionLabel', () => {
  const names = ['Igreja Exemplo A', 'IB Norte', 'IB Sul', STAFF_CHURCH];

  it('says Todas when nothing in the data is excluded', () => {
    assert.equal(churchSelectionLabel([], names).text, 'Todas');
    assert.equal(churchSelectionLabel(['Ausente'], names).text, 'Todas');
  });

  it('names a single exclusion and counts several', () => {
    assert.deepEqual(churchSelectionLabel([STAFF_CHURCH], names), {
      text: 'Todas exceto Convidado',
      full: 'Todas exceto Convidado',
    });
    const five = [...names, 'IB Leste', 'IB Oeste'];

    assert.deepEqual(churchSelectionLabel([STAFF_CHURCH, 'IB Sul'], five), {
      text: 'Todas exceto 2',
      full: 'Todas exceto IB Sul, Convidado',
    });
  });

  it('matches exclusions ignoring case and spacing', () => {
    assert.equal(
      churchSelectionLabel(['  convidado '], names).text,
      'Todas exceto Convidado',
    );
  });

  it('names the churches left when one or two remain', () => {
    assert.equal(
      churchSelectionLabel(excludeAllBut(names, ['Igreja Exemplo A']), names)
        .text,
      'Igreja Exemplo A',
    );
    assert.deepEqual(
      churchSelectionLabel(excludeAllBut(names, ['IB Sul', 'IB Norte']), names),
      { text: '2 igrejas', full: 'IB Norte e IB Sul' },
    );
  });

  it('says Nenhuma when everything is excluded', () => {
    assert.equal(churchSelectionLabel(names, names).text, 'Nenhuma');
  });
});

describe('ignoredBySurveys', () => {
  it('is false for the defaults and the audience filter', () => {
    assert.equal(ignoredBySurveys(DEFAULT_FILTERS), false);
    assert.equal(
      ignoredBySurveys({ ...DEFAULT_FILTERS, audience: 'volunteer' }),
      false,
    );
  });

  it('is true once the churches, ages or tickets are changed', () => {
    assert.equal(
      ignoredBySurveys({ ...DEFAULT_FILTERS, excludedChurches: [] }),
      true,
    );
    assert.equal(
      ignoredBySurveys({ ...DEFAULT_FILTERS, age: ['13–18'] }),
      true,
    );
    assert.equal(
      ignoredBySurveys({ ...DEFAULT_FILTERS, ticket: 'walkIn' }),
      true,
    );
  });
});
