import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OTHER_CHURCHES,
  SLIDE_IDS,
  deckOutline,
  eventDay,
  filterSummary,
  topChurches,
} from './deck.ts';
import { parseUploads } from './detect.ts';
import { DEFAULT_FILTERS, NO_FILTERS } from './filter.ts';
import { byChurch } from './metrics.ts';
import { generateSampleCsv } from './sample.ts';

import type { Attendee } from './checkin.ts';
import type { Filters } from './filter.ts';
import type { ChurchRow } from './metrics.ts';
import type { Definitions, ReportData } from './model.ts';

const definitions: Definitions = {
  participant: [
    { id: 'programme_rating', label: 'Programação', type: 'rating' },
    { id: 'food_rating', label: 'Alimentação', type: 'rating' },
    { id: 'overall_rating', label: 'Geral', type: 'rating' },
    { id: 'would_return', label: 'Voltaria', type: 'yes-no' },
    { id: 'low_rating_reason', label: 'Por quê', type: 'text' },
    { id: 'comments', label: 'Comentários', type: 'text' },
  ],
  volunteer: [
    { id: 'volunteer_area', label: 'Área', type: 'text' },
    { id: 'overall_rating', label: 'Geral', type: 'rating' },
  ],
};

const sample = generateSampleCsv(definitions);
const parsed = parseUploads(
  [
    { name: 'checkin.csv', text: sample.checkin },
    { name: 'survey-participant.csv', text: sample.participant },
    { name: 'survey-volunteer.csv', text: sample.volunteer ?? '' },
  ],
  definitions,
);
const full: ReportData = {
  attendees: parsed.attendees,
  surveys: parsed.surveys,
  resumoHtml: '<p>Resumo</p>',
  generatedAt: '2026-10-18T00:00:00Z',
};
const filtered = (patch: Partial<Filters>): Filters => ({
  ...NO_FILTERS,
  ...patch,
});
const without = (...ids: string[]): string[] =>
  SLIDE_IDS.filter((id) => !ids.includes(id));

const attendee = (patch: Partial<Attendee> = {}): Attendee => ({
  role: 'participant',
  walkIn: false,
  church: 'Igreja A',
  ageDetail: '15',
  saleDate: '2026-10-01',
  checkedIn: true,
  checkinAt: 1_000,
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

describe('deckOutline', () => {
  it('shows churches and ages before redemptions and yes/no before the ranking', () => {
    assert.deepEqual(deckOutline(full, NO_FILTERS), [
      'cover',
      'attendance',
      'sales',
      'checkin',
      'churches',
      'ages',
      'redemptions',
      'redemptionTimeline',
      'participantScore',
      'yesNo',
      'ranking',
      'structure',
      'volunteers',
      'areas',
      'resumo',
      'closing',
    ]);
  });

  const church = parsed.attendees.find(
    (a) => a.role === 'participant' && a.church !== null,
  )?.church;

  it('shows every slide for the sample', () => {
    assert.deepEqual(deckOutline(full, NO_FILTERS), [...SLIDE_IDS]);
  });

  it('drops the volunteer slides for participants', () => {
    assert.deepEqual(
      deckOutline(full, filtered({ audience: 'participant' })),
      without('volunteers', 'areas'),
    );
  });

  it('keeps only volunteer content for volunteers', () => {
    assert.deepEqual(
      deckOutline(full, filtered({ audience: 'volunteer' })),
      without(
        'attendance',
        'sales',
        'churches',
        'ages',
        'participantScore',
        'ranking',
        'structure',
        'yesNo',
      ),
    );
  });

  it('keeps the survey and churches slides under a church filter', () => {
    assert.ok(church);
    const outline = deckOutline(full, filtered({ excludedChurches: [church] }));

    assert.deepEqual(outline, [...SLIDE_IDS]);
  });

  it('follows the audience alone for surveys, but not volunteer rows', () => {
    assert.ok(church);
    const outline = deckOutline(
      full,
      filtered({ audience: 'volunteer', age: ['13–18'] }),
    );

    assert.ok(outline.includes('volunteers'));
    assert.ok(outline.includes('areas'));
    assert.ok(!outline.includes('attendance'));
    assert.ok(!outline.includes('churches'));
    assert.ok(!outline.includes('checkin'));
    assert.ok(!outline.includes('redemptions'));
    assert.ok(!outline.includes('redemptionTimeline'));
  });

  it('drops the redemptions slide when nothing was redeemed', () => {
    const attendees = full.attendees.map((a) => ({
      ...a,
      items: Object.fromEntries(
        Object.entries(a.items).map(([key, slot]) => [
          key,
          { ...slot, redeemedAt: null },
        ]),
      ) as Attendee['items'],
    }));

    assert.deepEqual(
      deckOutline({ ...full, attendees }, NO_FILTERS),
      without('redemptions', 'redemptionTimeline'),
    );
  });

  it('omits survey slides without surveys', () => {
    const outline = deckOutline(
      { ...full, surveys: { participant: null, volunteer: null } },
      NO_FILTERS,
    );

    assert.deepEqual(
      outline,
      without('participantScore', 'ranking', 'structure', 'yesNo', 'areas'),
    );
  });

  it('shows the attractions and structure slides on their own rows', () => {
    const only = (id: string): ReportData => ({
      ...full,
      surveys: {
        ...full.surveys,
        participant: full.surveys.participant && {
          ...full.surveys.participant,
          questions: full.surveys.participant.questions.filter(
            (q) =>
              q.type !== 'rating' || q.id === 'overall_rating' || q.id === id,
          ),
        },
      },
    });
    const attractions = deckOutline(only('programme_rating'), NO_FILTERS);
    const structure = deckOutline(only('food_rating'), NO_FILTERS);

    assert.ok(attractions.includes('ranking'));
    assert.ok(!attractions.includes('structure'));
    assert.ok(structure.includes('structure'));
    assert.ok(!structure.includes('ranking'));
  });

  it('shows the volunteers slide from a volunteer survey alone', () => {
    const outline = deckOutline(
      {
        ...full,
        attendees: full.attendees.filter((a) => a.role === 'participant'),
      },
      NO_FILTERS,
    );

    assert.ok(outline.includes('volunteers'));
  });

  it('omits the churches slide when nobody has a church', () => {
    const attendees = full.attendees.map((a) => ({ ...a, church: null }));

    assert.ok(
      !deckOutline({ ...full, attendees }, NO_FILTERS).includes('churches'),
    );
  });

  it('omits the ages slide when no participant has a band', () => {
    const attendees = full.attendees.map((a) => ({ ...a, ageDetail: null }));

    assert.ok(
      !deckOutline({ ...full, attendees }, NO_FILTERS).includes('ages'),
    );
  });

  it('ignores volunteer and archived bands for the ages slide', () => {
    const attendees = full.attendees.map((a) => ({
      ...a,
      ageDetail: a.role === 'volunteer' || a.archived ? '19+' : null,
    })) satisfies Attendee[];

    assert.ok(
      !deckOutline({ ...full, attendees }, NO_FILTERS).includes('ages'),
    );
  });

  it('shows the sales slide only for participants with a sale date', () => {
    const dated = (saleDate: string | null, patch: Partial<Attendee> = {}) =>
      deckOutline(
        { ...full, attendees: [attendee({ saleDate, ...patch })] },
        NO_FILTERS,
      );

    assert.ok(dated('2026-10-01').includes('sales'));
    assert.ok(!dated(null).includes('sales'));
    assert.ok(!dated('2026-10-01', { archived: true }).includes('sales'));
    assert.ok(!dated('2026-10-01', { role: 'volunteer' }).includes('sales'));
    assert.ok(
      !deckOutline(full, filtered({ audience: 'volunteer' })).includes('sales'),
    );
  });

  it('keeps the sales slide under church and age filters', () => {
    assert.ok(church);
    assert.ok(
      deckOutline(
        full,
        filtered({ excludedChurches: [church], age: ['13–18'] }),
      ).includes('sales'),
    );
  });

  it('keeps the ages slide under an age filter and hides it for volunteers', () => {
    assert.ok(deckOutline(full, filtered({ age: ['13–18'] })).includes('ages'));
    assert.ok(
      !deckOutline(full, filtered({ audience: 'volunteer' })).includes('ages'),
    );
  });

  it('omits the resumo slide without a summary', () => {
    assert.ok(
      !deckOutline({ ...full, resumoHtml: null }, NO_FILTERS).includes(
        'resumo',
      ),
    );
  });

  it('reduces to the cover and closing for empty data', () => {
    const empty: ReportData = {
      attendees: [],
      surveys: { participant: null, volunteer: null },
      resumoHtml: null,
      generatedAt: full.generatedAt,
    };

    assert.deepEqual(deckOutline(empty, NO_FILTERS), ['cover', 'closing']);
  });

  it('needs a timestamp for the check-in slide', () => {
    const data: ReportData = {
      ...full,
      attendees: [attendee({ checkinAt: null })],
    };

    assert.ok(!deckOutline(data, NO_FILTERS).includes('checkin'));
    assert.ok(
      deckOutline({ ...data, attendees: [attendee()] }, NO_FILTERS).includes(
        'checkin',
      ),
    );
  });
});

describe('eventDay', () => {
  it('uses the earliest participant check-in', () => {
    assert.equal(
      eventDay([
        attendee({ checkinAt: 500, role: 'volunteer' }),
        attendee({ checkinAt: 3_000 }),
        attendee({ checkinAt: 2_000 }),
        attendee({ checkinAt: 100, archived: true }),
      ]),
      2_000,
    );
  });

  it('falls back to volunteers, then to null', () => {
    assert.equal(
      eventDay([
        attendee({ checkinAt: 800, role: 'volunteer' }),
        attendee({ checkinAt: null }),
      ]),
      800,
    );
    assert.equal(eventDay([attendee({ checkinAt: null })]), null);
    assert.equal(eventDay([]), null);
  });
});

describe('topChurches', () => {
  const rows: ChurchRow[] = Array.from({ length: 5 }, (_, i) => ({
    church: `Igreja ${String(i)}`,
    tickets: 10 - i,
    checkedIn: 8 - i,
    absent: 2,
    noShowRate: 2 / (10 - i),
  }));

  it('returns the rows as they are when they fit', () => {
    assert.deepEqual(topChurches(rows, 5), rows);
    assert.deepEqual(topChurches([], 3), []);
  });

  it('sums the remainder into one row', () => {
    const result = topChurches(rows, 3);

    assert.deepEqual(result.slice(0, 3), rows.slice(0, 3));
    assert.deepEqual(result[3], {
      church: OTHER_CHURCHES,
      tickets: 13,
      checkedIn: 9,
      absent: 4,
      noShowRate: 4 / 13,
    });
    assert.equal(result.length, 4);
  });

  it('defaults to eight and works on real rows', () => {
    const many = byChurch(
      Array.from({ length: 10 }, (_, i) =>
        attendee({ church: `Igreja ${String(i)}` }),
      ),
    );
    const result = topChurches(many);

    assert.equal(result.length, 9);
    assert.equal(result[8]?.tickets, 2);
  });

  it('leaves the rate null when the rest has no tickets', () => {
    const zero: ChurchRow = {
      church: 'Z',
      tickets: 0,
      checkedIn: 0,
      absent: 0,
      noShowRate: null,
    };

    assert.equal(topChurches([zero, zero], 1)[1]?.noShowRate, null);
  });
});

describe('filterSummary', () => {
  it('is null without filters', () => {
    assert.equal(filterSummary(NO_FILTERS), null);
  });

  it('omits the church part for the default exclusions', () => {
    assert.equal(filterSummary({ ...DEFAULT_FILTERS, audience: 'all' }), null);
    assert.equal(
      filterSummary(DEFAULT_FILTERS, ['A', 'B', 'C']),
      'Filtros: Participantes',
    );
  });

  it('labels each filter', () => {
    assert.equal(
      filterSummary(filtered({ audience: 'volunteer' })),
      'Filtros: Voluntários',
    );
    assert.equal(
      filterSummary(filtered({ ticket: 'preSale' })),
      'Filtros: Ingressos antecipados',
    );
  });

  it('lists the churches kept when one or two remain', () => {
    const all = ['A', 'B', 'C', 'D'];

    assert.equal(
      filterSummary(filtered({ excludedChurches: ['B', 'C', 'D'] }), all),
      'Filtros: Igrejas: A',
    );
    assert.equal(
      filterSummary(filtered({ excludedChurches: ['c', 'D'] }), all),
      'Filtros: Igrejas: A, B',
    );
  });

  it('lists the churches left out when several remain', () => {
    const all = ['A', 'B', 'C', 'D'];

    assert.equal(
      filterSummary(filtered({ excludedChurches: ['A'] }), all),
      'Filtros: Igrejas: todas exceto A',
    );
    assert.equal(
      filterSummary(filtered({ excludedChurches: ['A', 'B'] })),
      'Filtros: Igrejas: todas exceto A, B',
    );
  });

  it('counts the churches left out when more than two', () => {
    assert.equal(
      filterSummary(filtered({ excludedChurches: ['A', 'B', 'C'] }), [
        'A',
        'B',
        'C',
        'D',
        'E',
        'F',
      ]),
      'Filtros: Igrejas: todas exceto 3',
    );
  });

  it('labels the age filter', () => {
    assert.equal(
      filterSummary(filtered({ age: ['13–18'] })),
      'Filtros: Idade: 13–18',
    );
    assert.equal(
      filterSummary(filtered({ age: ['≤12'] })),
      'Filtros: Idade: ≤12',
    );
  });

  it('lists a multi-band age filter in band order', () => {
    assert.equal(
      filterSummary(filtered({ age: ['19+', '≤12', '13–18'] })),
      'Filtros: Idade: ≤12, 13–18, 19+',
    );
  });

  it('joins combinations in a fixed order', () => {
    assert.equal(
      filterSummary({
        audience: 'participant',
        excludedChurches: ['Igreja Exemplo A'],
        age: ['13–18'],
        ticket: 'walkIn',
      }),
      'Filtros: Participantes · Igrejas: todas exceto Igreja Exemplo A · Idade: 13–18 · Comprados no dia',
    );
  });
});
