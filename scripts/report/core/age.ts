import type { Attendee } from './checkin.ts';

/** Age bands of the report, in ascending order. */
export const AGE_BANDS = ['≤12', '13–18', '19+'] as const;

/** One of the {@link AGE_BANDS}. */
export type AgeBand = (typeof AGE_BANDS)[number];

/** Age groups of the breakdown, in ascending order. */
export const AGE_DETAILS = [
  '≤12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19+',
] as const;

/** One of the {@link AGE_DETAILS}. */
export type AgeDetail = (typeof AGE_DETAILS)[number];

/** Label for participants whose age is blank. */
export const UNKNOWN_AGE = 'Não informada';

/** Youngest age of the 13–18 band. */
const TEEN = 13;
/** Youngest age in the open-ended top band. */
const ADULT = 19;

/**
 * Places an age in its detail group: single years from 13 to 18, collapsed
 * below and above.
 *
 * @param age - A whole number of years.
 */
export const ageDetail = (age: number): AgeDetail => {
  if (age < TEEN) return '≤12';
  if (age >= ADULT) return '19+';

  return String(age) as AgeDetail;
};

/**
 * The filter range a detail group belongs to.
 *
 * @param detail - A detail group.
 */
export const bandOfDetail = (detail: AgeDetail): AgeBand =>
  detail === '≤12' || detail === '19+' ? detail : '13–18';

/**
 * Places an age in its band.
 *
 * @param age - A whole number of years.
 */
export const ageBand = (age: number): AgeBand => bandOfDetail(ageDetail(age));

/**
 * The filter range of a registration.
 *
 * @param a - A registration.
 * @returns `null` when the age is blank or absent.
 */
export const ageBandOf = (a: Attendee): AgeBand | null =>
  a.ageDetail === null ? null : bandOfDetail(a.ageDetail);

/** A selectable value of the age filter. */
export type AgeChoice = AgeBand | typeof UNKNOWN_AGE;

/** Every {@link AgeChoice} in display order. */
const CHOICES: readonly AgeChoice[] = [...AGE_BANDS, UNKNOWN_AGE];

/** Sorts choices into {@link AGE_BANDS} order, unknown last, without repeats. */
const canonical = (selected: readonly AgeChoice[]): AgeChoice[] =>
  CHOICES.filter((choice) => selected.includes(choice));

/**
 * Adds a choice to the selection, or removes it when already selected.
 *
 * @param selected - The current selection.
 * @param choice - The choice to toggle.
 * @returns A new selection in canonical order.
 */
export const toggleAge = (
  selected: readonly AgeChoice[],
  choice: AgeChoice,
): AgeChoice[] =>
  canonical(
    selected.includes(choice)
      ? selected.filter((c) => c !== choice)
      : [...selected, choice],
  );

/**
 * Describes a selection.
 *
 * @param selected - The selection.
 * @returns Text such as "≤12, 13–18, Não informada", or `null` when empty.
 */
export const ageLabel = (selected: readonly AgeChoice[]): string | null =>
  selected.length === 0 ? null : canonical(selected).join(', ');

/**
 * Reads a saved age filter, tolerating stale or corrupt storage.
 *
 * @param value - An array of choices, or the single choice older builds saved.
 * @returns The valid, de-duplicated choices in canonical order.
 */
export const normaliseAgeChoices = (value: unknown): AgeChoice[] => {
  const items: unknown[] = Array.isArray(value) ? value : [value];

  return CHOICES.filter((choice) => items.includes(choice));
};
