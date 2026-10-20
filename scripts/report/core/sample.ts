import { STAFF_CHURCH } from './filter.ts';

import type { Definitions } from './model.ts';
import type { Question } from './survey.ts';

/** The three export files of a made-up event, as CSV text. */
export interface SampleCsv {
  checkin: string;
  participant: string;
  /** `null` when there is no volunteer survey. */
  volunteer: string | null;
}

const PARTICIPANTS = 650;
const VOLUNTEERS = 90;
const PARTICIPANT_RESPONSES = 200;
const VOLUNTEER_RESPONSES = 45;
const ARCHIVED = 6;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** UTC instant of 00:00 São Paulo time on the sample's event day. */
const DAY_START = Date.UTC(2026, 9, 17, 3);

/** Host church of the sample event. */
export const SAMPLE_HOST_CHURCH = 'Igreja Exemplo A';

const CHURCHES = [
  SAMPLE_HOST_CHURCH,
  'Igreja Exemplo B',
  'Igreja Exemplo C',
  'Igreja Exemplo D',
  'Igreja Exemplo E',
  'Igreja Exemplo F',
];
const CHURCH_WEIGHTS = [8, 6, 5, 3, 2, 1];
/** Share of participants invited as staff. */
const STAFF_SHARE = 0.03;

/** Ages a participant may have, weighted to peak at 15 to 17. */
const PARTICIPANT_AGES = [12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 25];
const PARTICIPANT_AGE_WEIGHTS = [2, 5, 10, 16, 18, 16, 10, 6, 4, 2, 1];

const CODE_ALPHABET = 'bcfghjkmnpqrstvwxz2346789';
const MEALS = ['Hambúrguer', 'Pizza', 'Vegetariano', 'Cachorro-quente'];
const DRINKS = ['Refrigerante', 'Suco de uva', 'Água'];
const LUNCHES = [
  'Marmita de carne',
  'Marmita de frango',
  'Marmita vegetariana',
];
const SIZES = ['P', 'M', 'G', 'GG'];

const AREA_VARIANTS: readonly (readonly [text: string, weight: number])[] = [
  ['ALIMENTAÇÃO', 6],
  ['Alimentacao', 3],
  ['CHECK-IN', 6],
  ['checkin', 3],
  ['Logística', 6],
  ['LOGISTICA', 2],
  ['Produção', 5],
  ['producao', 2],
  ['Técnica', 5],
  ['COMUNICAÇÃO', 4],
  ['Experiência do participante', 2],
  ['Lojinha', 1],
  ['Direção', 1],
  ['Check-in e Logística', 2],
  ['alimentação backstage', 1],
  ['Logistca', 1],
  ['Recepção', 1],
  ['Fiz de tudo um pouco', 1],
];

const COMMENTS: Readonly<Record<string, readonly string[]>> = {
  participant: [
    'Foi um dia ótimo, voltarei com certeza!',
    'A programação foi muito boa do começo ao fim.',
    'A fila da alimentação demorou um pouco, mas valeu a pena.',
    'Sugiro mais banheiros para a próxima edição.',
    'Organização nota 10, equipe muito atenciosa.',
    'O som estava alto demais nas primeiras fileiras.',
    'Gostei muito da atividade do intervalo.',
    'Poderia ter mais opções de lanche vegetariano.',
    'Ambiente acolhedor, trouxe minha família toda.',
    'Parabéns a todos os envolvidos!',
  ],
  low_rating_reason: [
    'A fila de check-in estava lenta no começo.',
    'Não consegui ver o palco direito do meu lugar.',
    'O preço do ingresso poderia ser menor.',
    'Faltou informação sobre o horário de cada atividade.',
    'O lanche acabou antes de eu chegar.',
  ],
  volunteer: [
    'Equipe muito unida, servir foi uma alegria.',
    'Faltou comunicação sobre o horário de chegada.',
    'Gostaria de mais treinamento antes do evento.',
    'A coordenação foi presente e nos deu todo o apoio.',
    'Poderíamos ter mais voluntários na parte da tarde.',
    'O aplicativo funcionou bem, só travou uma vez.',
    'A reunião de alinhamento foi muito útil.',
  ],
};

/** Deterministic 32-bit generator returning floats in [0, 1). */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const NEEDS_QUOTES = /[",\r\n]/;

const csvRow = (cells: readonly string[]): string =>
  cells
    .map((cell) =>
      NEEDS_QUOTES.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell,
    )
    .join(',');

/** Formats an instant the way Postgres prints `timestamptz` in São Paulo. */
const timestamp = (epochMs: number): string => {
  const local = new Date(epochMs - 3 * HOUR);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

  return (
    `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-` +
    `${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:` +
    `${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}.` +
    `${pad(local.getUTCMilliseconds(), 3)}000-03`
  );
};

/** Share of participants whose sale date is missing. */
const BLANK_SALE_DATE = 0.02;
/** Furthest back a ticket is sold, in days. */
const SALE_SPAN = 240;

/**
 * Days between a pre-sale ticket's sale and the event: some on the day, a
 * rush in the last two weeks, the rest spread over the earlier months.
 *
 * @param roll - A uniform draw in [0, 1).
 */
const daysBeforeEvent = (roll: number): number => {
  if (roll < 0.06) return 0;
  if (roll < 0.5) return 1 + Math.floor(((roll - 0.06) / 0.44) * 14);

  return 15 + Math.floor(((roll - 0.5) / 0.5) ** 1.4 * (SALE_SPAN - 15));
};

/**
 * Writes a sale date, mostly as `YYYY-MM-DD`, sometimes as `DD/MM/YYYY` or
 * with a time.
 *
 * @param days - Days before the event day.
 * @param roll - A uniform draw in [0, 1) choosing the format.
 */
const saleDateText = (days: number, roll: number): string => {
  const day = new Date(DAY_START - days * 24 * HOUR - 3 * HOUR);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const year = String(day.getUTCFullYear());
  const month = pad(day.getUTCMonth() + 1);
  const date = pad(day.getUTCDate());

  if (roll < 0.15) return `${date}/${month}/${year}`;
  if (roll < 0.22)
    return `${year}-${month}-${date} ${pad(8 + (Math.floor(roll * 100) % 14))}:30:00`;

  return `${year}-${month}-${date}`;
};

interface Person {
  code: string;
  role: 'participant' | 'volunteer';
  church: string;
  /** Blank when the age is unknown. */
  age: string;
  /** Blank when unknown or for volunteers; formats vary like real exports. */
  saleDate: string;
  checkinAt: number | null;
  meal: string;
  mealAt: number | null;
  drink: string;
  drinkAt: number | null;
  tshirt: string;
  tshirtAt: number | null;
  lunch: string;
  lunchAt: number | null;
  tshirtVolunteer: string;
  tshirtVolunteerAt: number | null;
  archivedAt: number | null;
}

/**
 * Generates CSV text for a made-up event in the exact format of the real
 * exports, so the sample goes through the same parsers as real files.
 *
 * @param definitions - The survey questions to answer.
 * @param seed - Seed of the generator; the same seed gives the same text.
 */
export const generateSampleCsv = (
  definitions: Definitions,
  seed = 2026,
): SampleCsv => {
  const random = mulberry32(seed);
  const between = (min: number, max: number): number =>
    min + random() * (max - min);
  const chance = (p: number): boolean => random() < p;
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;
  const char = (set: string): string =>
    set.charAt(Math.floor(random() * set.length));
  const weighted = <T>(items: readonly T[], weights: readonly number[]): T => {
    let roll = random() * weights.reduce((sum, w) => sum + w, 0);

    for (const [i, weight] of weights.entries()) {
      roll -= weight;
      if (roll < 0) return items[i] as T;
    }

    return items[items.length - 1] as T;
  };
  const normal = (mean: number, sd: number): number =>
    mean +
    sd *
      Math.sqrt(-2 * Math.log(1 - random())) *
      Math.cos(2 * Math.PI * random());
  /** A normal draw, redrawn until it falls inside the window. */
  const within = (
    mean: number,
    sd: number,
    from: number,
    to: number,
  ): number => {
    for (;;) {
      const value = normal(mean, sd);

      if (value >= from && value <= to) return value;
    }
  };
  const hours = (h: number, m = 0): number => DAY_START + h * HOUR + m * MINUTE;
  const code = (prefix: string): string =>
    prefix + Array.from({ length: 6 }, () => char(CODE_ALPHABET)).join('');

  const people: Person[] = [];

  const blank = (role: Person['role'], walkIn: boolean): Person => ({
    code: code(
      role === 'volunteer' ? 'v' : walkIn ? 'd' : pick(['a', 'b', 'c']),
    ),
    role,
    church: chance(0.05)
      ? ''
      : role === 'participant' && chance(STAFF_SHARE)
        ? STAFF_CHURCH
        : weighted(CHURCHES, CHURCH_WEIGHTS),
    age: '',
    saleDate: '',
    checkinAt: null,
    meal: '',
    mealAt: null,
    drink: '',
    drinkAt: null,
    tshirt: '',
    tshirtAt: null,
    lunch: '',
    lunchAt: null,
    tshirtVolunteer: '',
    tshirtVolunteerAt: null,
    archivedAt: null,
  });

  for (let i = 0; i < PARTICIPANTS; i++) {
    const walkIn = chance(0.1);
    const person = blank('participant', walkIn);

    person.age = chance(0.04)
      ? ''
      : String(weighted(PARTICIPANT_AGES, PARTICIPANT_AGE_WEIGHTS));
    person.meal = pick(MEALS);
    person.drink = pick(DRINKS);
    if (chance(0.4)) person.tshirt = pick(SIZES);
    if (i < ARCHIVED) {
      person.archivedAt = hours(9, 30);
    } else if (!chance(0.12)) {
      person.checkinAt =
        hours(0) + within(walkIn ? 19.9 : 19.5, 0.3, 19, 20.5) * HOUR;
      const arrived = person.checkinAt;
      const intermission = (): number =>
        Math.max(hours(20, between(10, 50)), arrived + 5 * MINUTE);

      if (chance(0.88)) person.mealAt = intermission();
      if (chance(0.82)) person.drinkAt = intermission();
    }
    people.push(person);
  }
  for (let i = 0; i < VOLUNTEERS; i++) {
    const person = blank('volunteer', false);

    person.age = String(Math.round(within(26, 7, 18, 40)));
    person.lunch = pick(LUNCHES);
    person.tshirtVolunteer = pick(SIZES);
    if (!chance(0.05)) {
      person.checkinAt = hours(0) + within(16, 0.5, 15, 17.5) * HOUR;
      const arrived = person.checkinAt;

      if (chance(0.85)) person.lunchAt = hours(17, 30 + between(0, 90));
      if (chance(0.9)) {
        person.tshirtVolunteerAt = arrived + between(0, 40) * MINUTE;
      }
    }
    people.push(person);
  }

  const sales = mulberry32(seed + 1);

  for (const person of people) {
    if (person.role === 'participant' && sales() >= BLANK_SALE_DATE) {
      person.saleDate = saleDateText(
        person.code.startsWith('d') ? 0 : daysBeforeEvent(sales()),
        sales(),
      );
    }
  }

  const order = people
    .flatMap((p) => (p.checkinAt === null ? [] : [p]))
    .sort((a, b) => (a.checkinAt ?? 0) - (b.checkinAt ?? 0));
  const numbers = new Map(order.map((p, i) => [p, i + 1]));
  const ts = (value: number | null): string =>
    value === null ? '' : timestamp(value);

  const checkin = [
    csvRow([
      'ticket_code',
      'attendee_role',
      'checkin_complete',
      'checkin_number',
      'checkin_at',
      'meal_option',
      'meal_redeemed_at',
      'drink_option',
      'drink_redeemed_at',
      'tshirt_size',
      'tshirt_redeemed_at',
      'lunch_option',
      'lunch_redeemed_at',
      'tshirt_volunteer_size',
      'tshirt_volunteer_redeemed_at',
      'archived_at',
      'church',
      'age',
      'sale_date',
    ]),
    ...people.map((p) =>
      csvRow([
        p.code,
        p.role,
        p.checkinAt === null ? 'f' : 't',
        String(numbers.get(p) ?? ''),
        ts(p.checkinAt),
        p.meal,
        ts(p.mealAt),
        p.drink,
        ts(p.drinkAt),
        p.tshirt,
        ts(p.tshirtAt),
        p.lunch,
        ts(p.lunchAt),
        p.tshirtVolunteer,
        ts(p.tshirtVolunteerAt),
        ts(p.archivedAt),
        p.church,
        p.age,
        p.saleDate,
      ]),
    ),
  ].join('\r\n');

  const survey = (
    questions: readonly Question[],
    count: number,
    audience: 'participant' | 'volunteer',
  ): string => {
    const means = new Map(
      questions.map((q) => [q.id, between(7.2, 9.6)] as const),
    );
    const rows = Array.from({ length: count }, () => {
      const answers = new Map<string, string>();
      let anyLow = false;

      for (const q of questions) {
        if (q.type === 'rating') {
          const score = Math.min(
            10,
            Math.max(1, Math.round(normal(means.get(q.id) ?? 8, 1.5))),
          );

          anyLow ||= score <= 7;
          answers.set(q.id, String(score));
        } else if (q.type === 'yes-no') {
          const share = q.id === 'would_return' ? 0.94 : 0.78;

          answers.set(q.id, chance(share) ? 'yes' : 'no');
        }
      }
      for (const q of questions) {
        if (q.type !== 'text') continue;
        let value = '';

        if (q.id === 'volunteer_area') {
          value = weighted(
            AREA_VARIANTS.map(([text]) => text),
            AREA_VARIANTS.map(([, weight]) => weight),
          );
        } else if (q.id === 'low_rating_reason') {
          if (anyLow && chance(0.6)) {
            value = pick(COMMENTS.low_rating_reason ?? []);
          }
        } else if (chance(0.35)) {
          value = pick(COMMENTS[audience] ?? []);
        }
        answers.set(q.id, value);
      }
      const id = Array.from({ length: 12 }, () =>
        char('0123456789abcdef'),
      ).join('');

      return csvRow([
        id,
        chance(0.7) ? '2026-10-17' : '2026-10-18',
        'v1',
        ...questions.map((q) => answers.get(q.id) ?? ''),
        '',
      ]);
    });

    return [
      csvRow([
        'response_id',
        'submitted_on',
        'survey_version',
        ...questions.map((q) => q.id),
        'other_answers',
      ]),
      ...rows,
    ].join('\r\n');
  };

  return {
    checkin,
    participant: survey(
      definitions.participant,
      PARTICIPANT_RESPONSES,
      'participant',
    ),
    volunteer: definitions.volunteer
      ? survey(definitions.volunteer, VOLUNTEER_RESPONSES, 'volunteer')
      : null,
  };
};
