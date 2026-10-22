/**
 * Single source of truth for the pass band's vocabulary and its clock.
 *
 * The band is rendered twice from the same inputs and never transmitted between
 * the two: once on the attendee's pass and once on the volunteer's own phone,
 * where the pair are compared by eye. Both sides derive it from the window
 * index and the lists below.
 *
 * WARN: This module is imported by browser code, so it must stay free of Node
 * built-ins and of anything the client tsconfig excludes.
 */

/**
 * The things an attendee can collect, and what they are called on-screen.
 *
 * Order is the order the pass renders its chips in, which is the order the
 * items sit on the table at a redemption station. The items in
 * {@link VOLUNTEER_ONLY_ITEMS} are never held by a participant.
 */
export const REDEEMABLE_ITEMS = {
  tshirt_volunteer: 'Camiseta voluntário',
  lunch: 'Almoço',
  tshirt: 'Camiseta',
  meal: 'Lanche',
  drink: 'Bebida',
} as const;

/** One collectable item. Mirrors the `item` check constraint. */
export type RedemptionItem = keyof typeof REDEEMABLE_ITEMS;

/**
 * The result of a redemption attempt.
 */
export const REDEMPTION_OUTCOMES = [
  'redeemed',
  'duplicate',
  'not_entitled',
] as const;

export type RedemptionOutcome = (typeof REDEMPTION_OUTCOMES)[number];

/** Narrows an unchecked string to a redeemable item. */
export const isRedemptionItem = (value: string): value is RedemptionItem =>
  Object.hasOwn(REDEEMABLE_ITEMS, value);

/**
 * Items only a volunteer may be entitled to.
 *
 * Each has a check constraint refusing it on a participant; the editor and the
 * roster import refuse it first with a readable message, and a participant's
 * staff card leaves it out.
 */
export const VOLUNTEER_ONLY_ITEMS: readonly RedemptionItem[] = [
  'tshirt_volunteer',
  'lunch',
];

/** Whether only a volunteer may be entitled to the item. */
export const isVolunteerOnlyItem = (item: RedemptionItem): boolean =>
  VOLUNTEER_ONLY_ITEMS.includes(item);

/**
 * How long a collected item stays on the attendee's pass, marked as collected,
 * before it is dropped from the chip list.
 */
export const REDEEMED_CHIP_VISIBLE_MS = 60 * 60_000;

/**
 * Decides whether a redemption slot earns a chip on the pass.
 *
 * A slot with neither a choice nor a redemption is not an entitlement. A
 * collected one is shown for {@link REDEEMED_CHIP_VISIBLE_MS} and then left off;
 * a reset clears the timestamp, so the chip returns as pending. An unparseable
 * timestamp keeps the chip, since hiding an item on bad data is the worse error.
 *
 * @param value - The registered choice, or null when not entitled.
 * @param redeemedAt - When the item was collected, or null while pending.
 * @param now - Current time in epoch milliseconds.
 * @returns Whether the chip should render.
 */
export const isChipShown = (
  value: string | null,
  redeemedAt: string | Date | null,
  now: number,
): boolean => {
  if (redeemedAt === null) return value !== null;

  const at =
    redeemedAt instanceof Date ? redeemedAt.getTime() : Date.parse(redeemedAt);
  if (Number.isNaN(at)) return true;

  return now - at < REDEEMED_CHIP_VISIBLE_MS;
};

/**
 * How long one band, and one generation of pass tokens, lasts.
 *
 * Short enough that a screenshot forwarded to someone in the same queue is
 * visibly stale by the time they reach the counter; long enough that an
 * attendee holding their phone out is not watching the band change mid-sentence.
 */
export const PASS_WINDOW_MS = 30_000;

/**
 * How many windows a pass token verifies against — the current one and the one
 * before it, so 60 seconds in total.
 *
 * A single window would reject a token minted a millisecond before a boundary,
 * which is the common case rather than an edge one: the attendee opens their
 * pass in the queue and is scanned some seconds later.
 */
export const PASS_TOKEN_WINDOWS = 2;

/**
 * The band's colour half. Decoration — {@link BAND_WORDS} is what is actually
 * compared.
 *
 * `VERDE` and `VERMELHO` are deliberately both here. Red and green is the pair
 * colour vision most often fails to separate, and that is the whole reason the
 * band carries a word as well as a hue: the same reasoning as the redemption
 * chips, which render `a retirar` beside their colour rather than relying on it.
 *
 * **The length is a power of two and must stay one.** `deriveBand` picks an
 * entry by masking a digest byte rather than taking a modulo, so the
 * distribution is exactly uniform with no rejection sampling to write. A ninth
 * colour would not widen the range — it would silently become unreachable.
 */
export const BAND_COLOURS = [
  'VERMELHO',
  'LARANJA',
  'AMARELO',
  'VERDE',
  'AZUL',
  'ROXO',
  'ROSA',
  'MARROM',
] as const;

/**
 * The band's word half, one list per language.
 *
 * A deployment shows a single language (`PASS_BAND_LANGUAGE`), whatever the
 * page language: the attendee's pass and the volunteer's screen are compared by
 * eye, so both must draw from the same list. This is a fixed vocabulary, not
 * catalog copy, and is not translated through the message catalogs.
 *
 * Every list follows the same rules. Words are concrete, short, and separable
 * when said out loud across a busy room. Near-rhymes are avoided.
 *
 * Position `n` is the same concept in every list where the language allowed
 * it (`BARCO` and `BOAT`, `LUA` and `MOON`); where a literal translation would
 * rhyme with another word or run long, a substitute stands in (`CAJU` is
 * `PEACH`, `SORVETE` is `GELATO`).
 *
 * 256 combinations when combining 32 words with eight colors:
 * a screenshot from ten minutes ago matches the live band with probability
 * 1/256.
 *
 * **The length is a power of two and must stay one**, for the same reason as
 * {@link BAND_COLOURS}: a thirty-third word would be unreachable, not an
 * addition. Every list must have the same length.
 */
export const BAND_WORDS = {
  'pt-BR': [
    'BARCO',
    'BOLO',
    'CAJU',
    'CAMPO',
    'CANOA',
    'CHUVA',
    'DADO',
    'FESTA',
    'FLOR',
    'FOGO',
    'FOLHA',
    'GATO',
    'ILHA',
    'JANELA',
    'LAGO',
    'LIVRO',
    'LUA',
    'MANGA',
    'MEL',
    'MORRO',
    'NUVEM',
    'PEDRA',
    'PEIXE',
    'PONTE',
    'PORTA',
    'RAIO',
    'SINO',
    'SORVETE',
    'TORRE',
    'TREM',
    'VELA',
    'VENTO',
  ],
  en: [
    'BOAT',
    'CAKE',
    'PEACH',
    'FIELD',
    'CANOE',
    'RAIN',
    'DICE',
    'PARTY',
    'ROSE',
    'FIRE',
    'LEAF',
    'CAT',
    'ISLAND',
    'WINDOW',
    'POND',
    'BOOK',
    'MOON',
    'MANGO',
    'HONEY',
    'HILL',
    'CLOUD',
    'STONE',
    'FISH',
    'BRIDGE',
    'DOOR',
    'BOLT',
    'BELL',
    'GELATO',
    'TOWER',
    'TRAM',
    'CANDLE',
    'BREEZE',
  ],
} as const;

/** A language the band's words are available in. */
export type BandLanguage = keyof typeof BAND_WORDS;

/** The band languages, for validating an unchecked string. */
export const BAND_LANGUAGES = Object.keys(BAND_WORDS) as BandLanguage[];

/** The band language used where none is configured. */
export const DEFAULT_BAND_LANGUAGE: BandLanguage = 'pt-BR';

/** Narrows an unchecked string to a band language. */
export const isBandLanguage = (value: string): value is BandLanguage =>
  Object.hasOwn(BAND_WORDS, value);

/**
 * The welcome line's phases, one per case of the `pass.welcome` message.
 *
 * The schedule — `PASS_WELCOME_SCHEDULE`, or the one saved at `/admin/pass` —
 * names these to say which text the pass shows from when. `arrival` is what shows before the first scheduled entry, and so what
 * every pass shows while the schedule is unset. `thanks` is normally reached
 * without being scheduled: an attendee who has answered the questionnaire sees
 * it in place of `survey` (see `welcomePhaseFor`).
 *
 * A phase added here needs its case in `pass.welcome`, or the typed accessor
 * refuses it at `tsc`.
 */
export const WELCOME_PHASES = [
  'arrival',
  'default',
  'survey',
  'thanks',
] as const;

/** One phase of the welcome line. */
export type WelcomePhase = (typeof WELCOME_PHASES)[number];

/** Narrows an unchecked value to a welcome phase. */
export const isWelcomePhase = (value: unknown): value is WelcomePhase =>
  (WELCOME_PHASES as readonly unknown[]).includes(value);

/**
 * Most entries an administrator may save in the welcome schedule.
 *
 * A bound on the request and on the row, not a planning limit: an event of a
 * few days switches the line a handful of times.
 */
export const WELCOME_SCHEDULE_MAX_ENTRIES = 50;

/**
 * The schedule's own phase: a line an administrator writes at `/admin/pass`,
 * carried on the entry rather than in `pass.welcome`. Kept out of
 * {@link WELCOME_PHASES} so `.env` cannot name it and the message needs no
 * case for it.
 */
export const WELCOME_CUSTOM_PHASE = 'custom';

/** Any phase a schedule entry may name: a built-in one, or a custom line. */
export type WelcomeLinePhase = WelcomePhase | typeof WELCOME_CUSTOM_PHASE;

/** Narrows an unchecked value to a built-in phase or the custom one. */
export const isWelcomeLinePhase = (value: unknown): value is WelcomeLinePhase =>
  value === WELCOME_CUSTOM_PHASE || isWelcomePhase(value);

/**
 * Longest custom line, in code points. The line sits under the attendee's name
 * and wraps on a phone, so it is meant for a sentence, not a notice.
 */
export const WELCOME_TEXT_MAX_LENGTH = 100;

/**
 * Reduces a custom line to the exact string that is stored and shown.
 *
 * The same steps as `normaliseNickname`, for the same reasons: NFC so the
 * length limit means one thing, whitespace collapsed before control characters
 * are stripped so a newline becomes a gap, and control and format code points
 * removed so no bidirectional override or zero-width padding reaches a pass.
 *
 * @param raw - Text as typed or as stored.
 * @returns The canonical form, which may be empty.
 */
export const normaliseWelcomeText = (raw: string): string =>
  raw.normalize('NFC').replace(/\s+/gu, ' ').replace(/\p{C}/gu, '').trim();
