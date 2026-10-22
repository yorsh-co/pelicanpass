/* eslint-disable no-restricted-syntax -- fictional attendee data, not interface copy. */

import type { AccessTier } from '../../../constants/access-tier.ts';
import type { AttendeeRole } from '../../../types/attendee.ts';
import type { DemoLocale } from './locale-route.ts';

/**
 * Fictional ticket codes the demo accepts.
 *
 * Shared by the demo build, which lists them in the banner, and the in-browser
 * mock API, which checks them in. Both are demo-only: nothing under
 * `src/web/client/demo` is an entry point, so the production bundle never
 * includes it.
 *
 * Each is six lowercase alphanumerics, as `isValidTicketCode` requires; the
 * volunteer code carries the volunteer key.
 */
export const DEMO_TICKET_CODES = {
  participant: ['k7m2q9', 'p4x8c3'],
  volunteer: ['v2n5r8'],
} as const;

/**
 * The phone digits the verification step asks for, the same for every attendee
 * so the banner can print them once.
 */
export const DEMO_VERIFICATION_CODE = '1234';

/** The token printed on the fictional venue poster, accepted by the QR step. */
export const DEMO_QR_TOKEN = 'PelicanPassDemo26';

/**
 * Team and role shown on every volunteer's pass, in each demo language.
 *
 * The pass page renders this line on the server, from the
 * `pass-volunteer-survey` view fixture, so the demo's one volunteer page can
 * only show one pair per language and the roster agrees with it.
 */
export const DEMO_VOLUNTEER_TEAM: Record<
  DemoLocale,
  { team: string; teamRole: string }
> = {
  'pt-BR': { team: 'Recepção', teamRole: 'Líder' },
  en: { team: 'Reception', teamRole: 'Lead' },
};

/**
 * The English wording of every redemption option in {@link DEMO_ROSTER}.
 *
 * The roster is written in Portuguese; the English demo looks each option up
 * here. T-shirt sizes are the same in both languages and are not listed.
 */
const ENGLISH_OPTIONS: Readonly<Record<string, string>> = {
  Vegetariano: 'Vegetarian',
  Vegano: 'Vegan',
  'Sem restrição': 'No restrictions',
  'Sem lactose': 'Lactose-free',
  'Sem glúten': 'Gluten-free',
  Frango: 'Chicken',
  'Suco de laranja': 'Orange juice',
  Água: 'Water',
  Café: 'Coffee',
  Refrigerante: 'Soda',
};

/** One fictional attendee, as registered. */
export interface RosterEntry {
  /** Lowercase six-character ticket code. */
  code: string;
  name: string;
  role: AttendeeRole;

  /** Whether the attendee is already checked in when the demo starts. */
  checkedIn: boolean;

  /** Thirteen E.164 digits. The last four are {@link DEMO_VERIFICATION_CODE}. */
  phone: string;

  /** Registered choices; `null` means no entitlement. */
  tshirtSize: string | null;
  mealOption: string | null;
  drinkOption: string | null;
  lunchOption: string | null;
  tshirtVolunteerSize: string | null;

  /** What a volunteer's pass may open. All `false` and `null` for a participant. */
  canRedeem: boolean;
  canDraw: boolean;
  showAdminLink: boolean;
  accessTier: AccessTier | null;
}

/**
 * An attendee as the page's language shows them: the options in English on an
 * English page, the entry itself for pt-BR.
 *
 * @param person - The attendee as registered, in Portuguese.
 * @param locale - The page's language.
 */
export const entryIn = (
  person: RosterEntry,
  locale: DemoLocale,
): RosterEntry => {
  if (locale !== 'en') return person;

  const english = (option: string | null): string | null =>
    option === null ? null : (ENGLISH_OPTIONS[option] ?? option);

  return {
    ...person,
    mealOption: english(person.mealOption),
    drinkOption: english(person.drinkOption),
    lunchOption: english(person.lunchOption),
  };
};

/** Builds a participant; they hold the shirt, meal and drink, never the volunteer items. */
const participant = (
  code: string,
  name: string,
  phoneStart: string,
  options: Pick<RosterEntry, 'tshirtSize' | 'mealOption' | 'drinkOption'> & {
    checkedIn: boolean;
  },
): RosterEntry => ({
  code,
  name,
  role: 'participant',
  phone: `${phoneStart}65${DEMO_VERIFICATION_CODE}`,
  lunchOption: null,
  tshirtVolunteerSize: null,
  canRedeem: false,
  canDraw: false,
  showAdminLink: false,
  accessTier: null,
  ...options,
});

/**
 * Builds a volunteer, who holds every item but the participant shirt and
 * carries no check-in number.
 */
const volunteer = (
  code: string,
  name: string,
  phoneStart: string,
  options: Pick<
    RosterEntry,
    | 'checkedIn'
    | 'canRedeem'
    | 'canDraw'
    | 'showAdminLink'
    | 'accessTier'
    | 'tshirtVolunteerSize'
  >,
): RosterEntry => ({
  code,
  name,
  role: 'volunteer',
  phone: `${phoneStart}65${DEMO_VERIFICATION_CODE}`,
  mealOption: 'Sem restrição',
  drinkOption: 'Água',
  lunchOption: 'Frango',
  tshirtSize: null,
  ...options,
});

/**
 * The demo's attendees: fifteen participants and five volunteers.
 *
 * The codes in {@link DEMO_TICKET_CODES} start unchecked-in, so a visitor
 * always has a pass to claim. The others arrive checked in, which gives the
 * raffle a pool and the staff screen people to serve before the visitor has
 * done anything. Participants are numbered in the order they appear here.
 */
export const DEMO_ROSTER: readonly RosterEntry[] = [
  participant('k7m2q9', 'Marina Albuquerque Teixeira', '5511987', {
    checkedIn: false,
    tshirtSize: 'M',
    mealOption: 'Vegetariano',
    drinkOption: 'Suco de laranja',
  }),
  participant('p4x8c3', 'Rafael Nogueira', '5521991', {
    checkedIn: false,
    tshirtSize: 'G',
    mealOption: 'Sem restrição',
    drinkOption: 'Café',
  }),
  participant('h9t3w6', 'Beatriz Lemos Prado', '5511976', {
    checkedIn: false,
    tshirtSize: 'P',
    mealOption: 'Vegano',
    drinkOption: 'Água',
  }),
  participant('a2d5f8', 'Caio Vasconcelos', '5531984', {
    checkedIn: true,
    tshirtSize: 'GG',
    mealOption: 'Sem restrição',
    drinkOption: 'Refrigerante',
  }),
  participant('b6g1j4', 'Helena Ribeiro Duarte', '5541993', {
    checkedIn: true,
    tshirtSize: 'M',
    mealOption: 'Vegetariano',
    drinkOption: 'Água',
  }),
  participant('c8k2m5', 'Thiago Moreira', '5511965', {
    checkedIn: true,
    tshirtSize: 'G',
    mealOption: 'Sem restrição',
    drinkOption: 'Café',
  }),
  participant('d3n7q1', 'Larissa Campos Freitas', '5585988', {
    checkedIn: true,
    tshirtSize: 'P',
    mealOption: 'Sem lactose',
    drinkOption: 'Suco de laranja',
  }),
  participant('e5p9r2', 'Gustavo Pereira', '5561972', {
    checkedIn: true,
    tshirtSize: 'M',
    mealOption: 'Sem restrição',
    drinkOption: 'Água',
  }),
  participant('f1s4t8', 'Isadora Matos Cardoso', '5551981', {
    checkedIn: true,
    tshirtSize: 'M',
    mealOption: 'Vegano',
    drinkOption: 'Refrigerante',
  }),
  participant('g7u3v6', 'Leonardo Barros', '5571994', {
    checkedIn: true,
    tshirtSize: 'G',
    mealOption: 'Sem restrição',
    drinkOption: 'Café',
  }),
  participant('j2w8x4', 'Priscila Andrade Gomes', '5511958', {
    checkedIn: true,
    tshirtSize: 'P',
    mealOption: 'Vegetariano',
    drinkOption: 'Água',
  }),
  participant('m4y6z9', 'Otávio Salgado', '5521967', {
    checkedIn: true,
    tshirtSize: 'GG',
    mealOption: 'Sem restrição',
    drinkOption: 'Suco de laranja',
  }),
  participant('n9a1b3', 'Valentina Rocha Miranda', '5531975', {
    checkedIn: true,
    tshirtSize: 'M',
    mealOption: 'Sem glúten',
    drinkOption: 'Água',
  }),
  participant('q5c7d2', 'Henrique Tavares', '5541989', {
    checkedIn: true,
    tshirtSize: 'G',
    mealOption: 'Sem restrição',
    drinkOption: 'Refrigerante',
  }),
  participant('r8e4f6', 'Camila Furtado Neves', '5585963', {
    checkedIn: true,
    tshirtSize: 'P',
    mealOption: 'Vegetariano',
    drinkOption: 'Café',
  }),
  volunteer('v2n5r8', 'Júlia Fontes Carvalho', '5511982', {
    checkedIn: false,
    canRedeem: true,
    canDraw: true,
    showAdminLink: true,
    accessTier: 'edit',
    tshirtVolunteerSize: 'M',
  }),
  volunteer('v6b3k7', 'Bruno Siqueira', '5511971', {
    checkedIn: true,
    canRedeem: true,
    canDraw: false,
    showAdminLink: false,
    accessTier: 'redeem',
    tshirtVolunteerSize: 'G',
  }),
  volunteer('v9d1m4', 'Aline Peixoto', '5521986', {
    checkedIn: true,
    canRedeem: false,
    canDraw: true,
    showAdminLink: false,
    accessTier: 'raffle',
    tshirtVolunteerSize: 'P',
  }),
  volunteer('v3f8p2', 'Diego Amaral', '5531979', {
    checkedIn: true,
    canRedeem: true,
    canDraw: false,
    showAdminLink: false,
    accessTier: 'tshirt',
    tshirtVolunteerSize: 'GG',
  }),
  volunteer('v7h5t1', 'Fernanda Quadros', '5541992', {
    checkedIn: true,
    canRedeem: false,
    canDraw: false,
    showAdminLink: false,
    accessTier: 'none',
    tshirtVolunteerSize: 'M',
  }),
];
