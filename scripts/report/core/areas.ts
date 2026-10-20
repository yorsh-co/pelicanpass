/** Volunteer areas as the organisers name them, in display form. */
export const AREAS: readonly string[] = [
  'ALIMENTAÇÃO',
  'ALIMENTAÇÃO BACKSTAGE',
  'AMBIENTAÇÃO',
  'ARTES',
  'CHECK-IN',
  'COMUNICAÇÃO',
  'DIREÇÃO',
  'COORDENAÇÃO',
  'LOGÍSTICA',
  'LOJINHA',
  'PRIMEIROS SOCORROS',
  'PRODUÇÃO',
  'SHOW DO INTERVALO',
  'VOLUNTÁRIOS',
  'EXPERIÊNCIA DO PARTICIPANTE',
  'TÉCNICA',
];

/**
 * Short forms volunteers commonly type, by normalised text. Kept to
 * unambiguous cases: each names one area and no other area's name contains it.
 */
const ALIASES: Readonly<Record<string, string>> = {
  CHECKIN: 'CHECK-IN',
  EXPERIENCIA: 'EXPERIÊNCIA DO PARTICIPANTE',
  SHOW: 'SHOW DO INTERVALO',
  SOCORROS: 'PRIMEIROS SOCORROS',
  BACKSTAGE: 'ALIMENTAÇÃO BACKSTAGE',
  VOLUNTARIO: 'VOLUNTÁRIOS',
  ARTE: 'ARTES',
};

/**
 * Uppercases, strips diacritics and collapses everything that is not a letter
 * or digit into single spaces.
 *
 * @param text - Free text.
 */
const normalise = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

/** Phrases to look for, each with the area it names, longest phrase first. */
const PHRASES: readonly (readonly [phrase: string, area: string])[] = [
  ...AREAS.map((area): [string, string] => [normalise(area), area]),
  ...Object.entries(ALIASES).map(([alias, area]): [string, string] => [
    alias,
    area,
  ]),
].sort((a, b) => b[0].length - a[0].length);

/**
 * Blanks out every whole-word occurrence of a phrase.
 *
 * @returns The text with matches replaced by spaces, or `null` if none.
 */
const removePhrase = (text: string, phrase: string): string | null => {
  let result = text;
  let found = false;
  let from = result.indexOf(phrase);

  while (from !== -1) {
    const end = from + phrase.length;

    if ((result[from - 1] ?? ' ') === ' ' && (result[end] ?? ' ') === ' ') {
      result =
        result.slice(0, from) + ' '.repeat(phrase.length) + result.slice(end);
      found = true;
    }
    from = result.indexOf(phrase, end);
  }

  return found ? result : null;
};

/**
 * Finds the volunteer areas named in a free-text answer.
 *
 * Longer names match first and are removed from the text, so
 * "Alimentação Backstage" yields that area alone, not also "Alimentação".
 *
 * @param text - The raw answer.
 * @returns Canonical area names in list order; empty when none is recognised.
 */
export const matchAreas = (text: string): string[] => {
  let rest = ` ${normalise(text)} `;
  const found = new Set<string>();

  for (const [phrase, area] of PHRASES) {
    const next = removePhrase(rest, phrase);

    if (next !== null) {
      rest = next;
      found.add(area);
    }
  }

  return AREAS.filter((area) => found.has(area));
};
