import assert from 'node:assert/strict';
import { applyFilters, DEFAULT_FILTERS, STAFF_CHURCH } from './filter.ts';
import { describe, it } from 'node:test';

import {
  byAgeDetail,
  byArea,
  byChurch,
  checkinMilestones,
  checkinSeries,
  hostChurchSplit,
  itemSummary,
  optionBreakdown,
  rankByMean,
  ratingStats,
  redeemedItems,
  redemptionSeries,
  responseRate,
  scoreBands,
  textAnswers,
  textComments,
  ticketSummary,
  volunteerSummary,
  yesNoStats,
} from './metrics.ts';

import type { Attendee, ItemKey } from './checkin.ts';
import type { SurveyData } from './survey.ts';

const MIN = 60_000;
// 14:00 in São Paulo.
const T0 = Date.parse('2026-10-18T17:00:00Z');

const none = { option: null, redeemedAt: null };

const person = (over: Partial<Attendee> = {}): Attendee => ({
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

const arrived = (minutes: number, over: Partial<Attendee> = {}): Attendee =>
  person({ checkedIn: true, checkinAt: T0 + minutes * MIN, ...over });

const withItem = (
  item: ItemKey,
  option: string | null,
  minutes: number | null,
  over: Partial<Attendee> = {},
): Attendee => {
  const base = person(over);

  return {
    ...base,
    items: {
      ...base.items,
      [item]: {
        option,
        redeemedAt: minutes === null ? null : T0 + minutes * MIN,
      },
    },
  };
};

describe('ticketSummary', () => {
  it('splits pre-sale and walk-in and excludes archived', () => {
    const summary = ticketSummary([
      arrived(0),
      person(),
      arrived(1, { walkIn: true }),
      person({ walkIn: true }),
      person({ walkIn: true }),
      arrived(2, { role: 'volunteer' }),
      person({ archived: true }),
      person({ archived: true, role: 'volunteer' }),
    ]);

    assert.deepEqual(summary, {
      tickets: 5,
      checkedIn: 2,
      absent: 3,
      noShowRate: 0.6,
      walkIns: 3,
      preSale: { tickets: 2, checkedIn: 1, absent: 1, noShowRate: 0.5 },
      walkIn: { tickets: 3, checkedIn: 1, absent: 2, noShowRate: 2 / 3 },
      archived: 2,
    });
  });

  it('has no origin split when any walkIn is unknown', () => {
    const summary = ticketSummary([person({ walkIn: null }), person()]);

    assert.equal(summary.walkIns, null);
    assert.equal(summary.preSale, null);
    assert.equal(summary.walkIn, null);
    assert.equal(summary.tickets, 2);
  });

  it('ignores unknown origin on archived rows', () => {
    const summary = ticketSummary([
      person(),
      person({ walkIn: null, archived: true }),
    ]);

    assert.equal(summary.walkIns, 0);
  });

  it('has a null rate without tickets', () => {
    const summary = ticketSummary([]);

    assert.equal(summary.noShowRate, null);
    assert.equal(summary.preSale?.noShowRate, null);
    assert.equal(summary.walkIns, 0);
  });
});

describe('volunteerSummary', () => {
  it('counts volunteers who arrived', () => {
    assert.deepEqual(
      volunteerSummary([
        arrived(0, { role: 'volunteer' }),
        person({ role: 'volunteer' }),
        person({ role: 'volunteer', archived: true }),
        arrived(0),
      ]),
      { total: 2, checkedIn: 1, rate: 0.5 },
    );
    assert.equal(volunteerSummary([]).rate, null);
  });
});

describe('checkinSeries', () => {
  it('fills empty slots and accumulates', () => {
    const series = checkinSeries(
      [
        arrived(1),
        arrived(14, { role: 'volunteer' }),
        arrived(50),
        arrived(2, { archived: true }),
        person(),
        person({ checkedIn: true }),
      ],
      15,
    );

    assert.deepEqual(series, [
      { start: T0, participant: 1, volunteer: 1, total: 2, cumulative: 2 },
      {
        start: T0 + 15 * MIN,
        participant: 0,
        volunteer: 0,
        total: 0,
        cumulative: 2,
      },
      {
        start: T0 + 30 * MIN,
        participant: 0,
        volunteer: 0,
        total: 0,
        cumulative: 2,
      },
      {
        start: T0 + 45 * MIN,
        participant: 1,
        volunteer: 0,
        total: 1,
        cumulative: 3,
      },
    ]);
  });

  it('is empty without check-ins', () => {
    assert.deepEqual(checkinSeries([person()], 15), []);
  });
});

describe('checkinMilestones', () => {
  it('finds the peak slot and the 50% and 90% instants', () => {
    const people = [
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((m) => arrived(m)),
      arrived(40),
    ];
    const result = checkinMilestones(people, 15);

    assert.deepEqual(result.peak, { start: T0, count: 9 });
    assert.equal(result.half, T0 + 4 * MIN);
    assert.equal(result.ninety, T0 + 8 * MIN);
  });

  it('picks the earliest slot on a tie and handles no check-ins', () => {
    const tie = checkinMilestones([arrived(1), arrived(16)], 15);

    assert.deepEqual(tie.peak, { start: T0, count: 1 });
    assert.deepEqual(checkinMilestones([], 15), {
      peak: null,
      half: null,
      ninety: null,
    });
  });
});

describe('byChurch', () => {
  it('groups participants, sorted by tickets', () => {
    const rows = byChurch([
      arrived(0, { church: 'B' }),
      person({ church: 'B' }),
      person({ church: 'A' }),
      person(),
      person({ church: 'B', archived: true }),
      arrived(0, { role: 'volunteer', church: 'A' }),
    ]);

    assert.deepEqual(rows, [
      { church: 'B', tickets: 2, checkedIn: 1, absent: 1, noShowRate: 0.5 },
      { church: 'A', tickets: 1, checkedIn: 0, absent: 1, noShowRate: 1 },
      {
        church: 'Não informada',
        tickets: 1,
        checkedIn: 0,
        absent: 1,
        noShowRate: 1,
      },
    ]);
  });
});

describe('byAgeDetail', () => {
  const rows = byAgeDetail([
    arrived(0, { ageDetail: '15' }),
    person({ ageDetail: '15' }),
    person({ ageDetail: '≤12' }),
    person({ ageDetail: '19+', archived: true }),
    arrived(0, { role: 'volunteer', ageDetail: '19+' }),
    person(),
  ]);

  it('lists every group in order, zero rows included, then unknown', () => {
    assert.deepEqual(
      rows.map((r) => r.detail),
      ['≤12', '13', '14', '15', '16', '17', '18', '19+', 'Não informada'],
    );
  });

  it('carries the filter range of each group', () => {
    assert.deepEqual(
      rows.map((r) => r.band),
      [
        '≤12',
        '13–18',
        '13–18',
        '13–18',
        '13–18',
        '13–18',
        '13–18',
        '19+',
        null,
      ],
    );
  });

  it('counts non-archived participants only', () => {
    assert.deepEqual(rows[3], {
      detail: '15',
      band: '13–18',
      tickets: 2,
      checkedIn: 1,
      absent: 1,
      noShowRate: 0.5,
    });
    assert.deepEqual(rows[7], {
      detail: '19+',
      band: '19+',
      tickets: 0,
      checkedIn: 0,
      absent: 0,
      noShowRate: null,
    });
    assert.equal(rows[0]?.tickets, 1);
    assert.equal(rows[8]?.tickets, 1);
  });

  it('omits the unknown row when every participant has an age', () => {
    const known = byAgeDetail([person({ ageDetail: '15' })]);

    assert.equal(known.length, 8);
    assert.ok(known.every((r) => r.detail !== 'Não informada'));
  });

  it('is empty when no participant has an age', () => {
    assert.deepEqual(byAgeDetail([person(), person({ archived: true })]), []);
    assert.deepEqual(byAgeDetail([]), []);
    assert.deepEqual(
      byAgeDetail([person({ role: 'volunteer', ageDetail: '19+' })]),
      [],
    );
  });
});

describe('hostChurchSplit', () => {
  const HOST = 'Igreja Exemplo A';

  it('matches the host ignoring case and whitespace', () => {
    const result = hostChurchSplit(
      [
        arrived(0, { church: 'Igreja Exemplo A' }),
        person({ church: '  igreja   EXEMPLO a ' }),
        arrived(0, { church: 'Outra' }),
        person({ church: 'Outra 2' }),
        person({ church: 'Outra 2' }),
        person(),
        arrived(0, { role: 'volunteer', church: 'Igreja Exemplo A' }),
      ],
      HOST,
    );

    assert.deepEqual(result, {
      host: { tickets: 2, checkedIn: 1, absent: 1, noShowRate: 0.5 },
      others: { tickets: 3, checkedIn: 1, absent: 2, noShowRate: 2 / 3 },
      unknown: 1,
    });
  });

  it('leaves archived participants out', () => {
    const result = hostChurchSplit(
      [
        person({ church: 'Igreja Exemplo A' }),
        person({ church: 'Igreja Exemplo A', archived: true }),
        person({ church: 'Outra', archived: true }),
        person({ archived: true }),
      ],
      HOST,
    );

    assert.ok(result);
    assert.equal(result.host.tickets, 1);
    assert.equal(result.others.tickets, 0);
    assert.equal(result.unknown, 0);
  });

  it('leaves excluded staff out of the others when filtered upstream', () => {
    const attendees = [
      person({ church: 'Igreja Exemplo A' }),
      person({ church: 'Outra' }),
      person({ church: STAFF_CHURCH }),
    ];
    const kept = applyFilters(attendees, DEFAULT_FILTERS);

    assert.equal(hostChurchSplit(attendees, HOST)?.others.tickets, 2);
    assert.equal(hostChurchSplit(kept, HOST)?.others.tickets, 1);
  });

  it('returns null without host participants', () => {
    assert.equal(hostChurchSplit([person({ church: 'Outra' })], HOST), null);
    assert.equal(hostChurchSplit([], HOST), null);
  });

  it('returns null without a host church configured', () => {
    assert.equal(
      hostChurchSplit([person({ church: 'Igreja Exemplo A' })], null),
      null,
    );
  });
});

describe('redeemedItems', () => {
  it('drops items nobody redeemed', () => {
    const rows = redeemedItems([
      withItem('meal', 'Pizza', 1),
      withItem('tshirt', 'M', null),
    ]);

    assert.deepEqual(
      rows.map((r) => r.item),
      ['meal'],
    );
    assert.equal(redeemedItems([withItem('tshirt', 'M', null)]).length, 0);
  });
});

describe('itemSummary', () => {
  it('summarises per item and role, omitting unentitled combinations', () => {
    const rows = itemSummary([
      withItem('meal', 'A', 10),
      withItem('meal', 'B', 70),
      withItem('meal', 'A', null),
      withItem('meal', 'A', 5, { archived: true }),
      withItem('meal', 'A', 20, { role: 'volunteer' }),
      withItem('drink', null, 30),
    ]);

    assert.deepEqual(rows, [
      {
        item: 'meal',
        role: 'participant',
        entitled: 3,
        redeemed: 2,
        rate: 2 / 3,
        first: T0 + 10 * MIN,
        last: T0 + 70 * MIN,
        windowMs: 60 * MIN,
      },
      {
        item: 'meal',
        role: 'volunteer',
        entitled: 1,
        redeemed: 1,
        rate: 1,
        first: T0 + 20 * MIN,
        last: T0 + 20 * MIN,
        windowMs: 0,
      },
    ]);
  });

  it('has null timings when nothing was redeemed', () => {
    assert.deepEqual(
      itemSummary([withItem('lunch', 'X', null)]).map((r) => [
        r.rate,
        r.first,
        r.windowMs,
      ]),
      [[0, null, null]],
    );
  });
});

describe('itemSummary without an option', () => {
  it('ignores a redemption by someone with no option', () => {
    assert.deepEqual(
      itemSummary([withItem('meal', 'A', 10), withItem('meal', null, 50)]).map(
        (r) => [r.entitled, r.redeemed, r.rate, r.last],
      ),
      [[1, 1, 1, T0 + 10 * MIN]],
    );
  });
});

describe('redemptionSeries', () => {
  it('counts redemptions per slot by role', () => {
    const series = redemptionSeries(
      [
        withItem('meal', 'A', 1),
        withItem('meal', 'A', 31, { role: 'volunteer' }),
        withItem('meal', 'A', 2, { archived: true }),
        withItem('drink', 'A', 3),
      ],
      'meal',
      30,
    );

    assert.deepEqual(series, [
      { start: T0, participant: 1, volunteer: 0, total: 1, cumulative: 1 },
      {
        start: T0 + 30 * MIN,
        participant: 0,
        volunteer: 1,
        total: 1,
        cumulative: 2,
      },
    ]);
  });

  it('carries the running total through empty slots', () => {
    const series = redemptionSeries(
      [
        withItem('meal', 'A', 1),
        withItem('meal', 'A', 2),
        withItem('meal', 'A', 12),
      ],
      'meal',
      5,
    );

    assert.deepEqual(
      series.map((slot) => slot.cumulative),
      [2, 2, 3],
    );
  });
});

describe('optionBreakdown', () => {
  it('counts ordered and redeemed, most ordered first', () => {
    assert.deepEqual(
      optionBreakdown(
        [
          withItem('tshirt', 'M', 1),
          withItem('tshirt', 'G', null),
          withItem('tshirt', 'G', 2),
          withItem('tshirt', 'G', 3, { archived: true }),
          withItem('tshirt', null, null),
        ],
        'tshirt',
      ),
      [
        { option: 'G', ordered: 2, redeemed: 1 },
        { option: 'M', ordered: 1, redeemed: 1 },
      ],
    );
  });
});

const survey: SurveyData = {
  questions: [
    { id: 'volunteer_area', label: 'Área', type: 'text' },
    { id: 'q1', label: 'Q1', type: 'rating' },
    { id: 'q2', label: 'Q2', type: 'rating' },
    { id: 'yn', label: 'YN', type: 'yes-no' },
  ],
  responses: [],
};

const reply = (
  area: string | null,
  q1: number | null,
  q2: number | null = null,
  yn: boolean | null = null,
): SurveyData['responses'][number] => ({
  submittedOn: null,
  answers: { volunteer_area: area, q1, q2, yn },
});

describe('survey metrics', () => {
  const data: SurveyData = {
    ...survey,
    responses: [
      reply('Check-in', 10, 4, true),
      reply('Check-in', 7, null, false),
      reply(null, 3, null, true),
    ],
  };

  it('computes the response rate', () => {
    assert.equal(responseRate(data.responses, 6), 0.5);
    assert.equal(responseRate(data.responses, 0), null);
  });

  it('computes rating stats and ranks by mean', () => {
    const stats = ratingStats(data);

    assert.deepEqual(
      stats.map((s) => [s.id, s.n, s.mean]),
      [
        ['q1', 3, 20 / 3],
        ['q2', 1, 4],
      ],
    );
    assert.deepEqual(stats[0]?.distribution, [0, 0, 1, 0, 0, 0, 1, 0, 0, 1]);
    assert.deepEqual(
      rankByMean([...stats].reverse()).map((s) => s.id),
      ['q1', 'q2'],
    );
    assert.deepEqual(
      rankByMean([
        { id: 'a', label: 'a', n: 0, mean: null, distribution: [] },
        { id: 'b', label: 'b', n: 1, mean: 1, distribution: [] },
      ]).map((s) => s.id),
      ['b', 'a'],
    );
    assert.equal(ratingStats({ ...data, responses: [] })[0]?.mean, null);
  });

  it('bands scores', () => {
    assert.deepEqual(scoreBands([10, 9, 8, 7, 6, 1]), {
      n: 6,
      high: { count: 2, share: 1 / 3 },
      mid: { count: 2, share: 1 / 3 },
      low: { count: 2, share: 1 / 3 },
    });
    assert.equal(scoreBands([]).high.share, null);
  });

  it('computes yes-no stats', () => {
    assert.deepEqual(yesNoStats(data), [
      { id: 'yn', label: 'YN', n: 3, yes: 2, no: 1, yesShare: 2 / 3 },
    ]);
    assert.equal(yesNoStats({ ...data, responses: [] })[0]?.yesShare, null);
  });

  it('collects non-empty text answers', () => {
    assert.deepEqual(textAnswers(data), [
      {
        id: 'volunteer_area',
        label: 'Área',
        answers: ['Check-in', 'Check-in'],
      },
    ]);
  });
});

describe('textComments', () => {
  const questions: SurveyData['questions'] = [
    { id: 'overall_rating', label: 'Nota geral', type: 'rating' },
    { id: 'would_invite', label: 'Convidaria?', type: 'yes-no' },
    { id: 'overall_rating_comment', label: 'Explique', type: 'text' },
    { id: 'why_not_invite', label: 'Por quê?', type: 'text' },
    { id: 'comments', label: 'Final', type: 'text' },
  ];
  const response = (
    answers: Record<string, string | number | boolean | null>,
  ): SurveyData['responses'][number] => ({
    submittedOn: null,
    answers: {
      overall_rating: null,
      would_invite: null,
      overall_rating_comment: null,
      why_not_invite: null,
      comments: null,
      ...answers,
    },
  });
  const data: SurveyData = {
    questions,
    responses: [
      response({
        overall_rating: 9,
        overall_rating_comment: 'ótimo',
        comments: 'obrigado',
      }),
      response({ overall_rating_comment: '   ', comments: '' }),
      response({
        overall_rating: 4,
        would_invite: false,
        overall_rating_comment: 'fila grande',
        why_not_invite: 'não conheço ninguém',
      }),
      response({ overall_rating_comment: 'sem nota' }),
    ],
  };

  it('skips blank answers and orders by question then response', () => {
    assert.deepEqual(
      textComments(data).map((c) => [c.questionId, c.text]),
      [
        ['overall_rating_comment', 'ótimo'],
        ['overall_rating_comment', 'fila grande'],
        ['overall_rating_comment', 'sem nota'],
        ['why_not_invite', 'não conheço ninguém'],
        ['comments', 'obrigado'],
      ],
    );
  });

  it('attaches the same response answer to the parent', () => {
    const [first, second, third, yesNo] = textComments(data);

    assert.deepEqual(first?.parent, {
      id: 'overall_rating',
      label: 'Nota geral',
      answer: 9,
    });
    assert.equal(second?.parent?.answer, 4);
    assert.equal(third?.parent?.answer, null);
    assert.deepEqual(yesNo?.parent, {
      id: 'would_invite',
      label: 'Convidaria?',
      answer: false,
    });
  });

  it('leaves parent null for questions that follow nothing', () => {
    assert.equal(textComments(data).at(-1)?.parent, null);
  });
});

describe('byArea', () => {
  const many = (area: string, count: number, q1: number) =>
    Array.from({ length: count }, () => reply(area, q1, null));

  it('averages per area and counts multi-area answers in each', () => {
    const result = byArea({
      ...survey,
      responses: [
        ...many('check-in', 4, 8),
        reply('Check-in e técnica', 10, 6),
        ...many('Técnica', 4, 6),
      ],
    });

    assert.deepEqual(result, {
      areas: [
        { area: 'CHECK-IN', n: 5, means: { q1: 8.4, q2: 6 } },
        { area: 'TÉCNICA', n: 5, means: { q1: 6.8, q2: 6 } },
      ],
      suppressedCount: 0,
      unmatched: [],
    });
  });

  it('suppresses areas below minN and reports unmatched answers', () => {
    const result = byArea({
      ...survey,
      responses: [
        ...many('Logística', 4, 5),
        ...many('Artes', 5, 9),
        reply('não lembro', 5),
        reply('não lembro', 5),
        reply(null, 5),
      ],
    });

    assert.deepEqual(
      result.areas.map((a) => [a.area, a.n]),
      [['ARTES', 5]],
    );
    assert.equal(result.suppressedCount, 1);
    assert.deepEqual(result.unmatched, ['não lembro']);
    assert.equal(
      byArea({ ...survey, responses: many('Artes', 2, 5) }, 2).areas[0]?.n,
      2,
    );
  });

  it('is empty when the survey has no area question', () => {
    assert.deepEqual(byArea({ questions: [], responses: [] }), {
      areas: [],
      suppressedCount: 0,
      unmatched: [],
    });
  });
});
