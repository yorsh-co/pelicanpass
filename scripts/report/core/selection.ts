import { SLIDE_IDS } from './deck.ts';

import type { SlideId } from './deck.ts';

/** Sorts ids into {@link SLIDE_IDS} order without repeats. */
const canonical = (ids: readonly SlideId[]): SlideId[] =>
  SLIDE_IDS.filter((id) => ids.includes(id));

/**
 * Removes the excluded slides from the outline.
 *
 * @param outline - The available slides, in presentation order.
 * @param excluded - Slides the organiser left out; ids absent from the outline
 * are ignored.
 * @returns The slides to show, in outline order.
 */
export const selectSlides = (
  outline: readonly SlideId[],
  excluded: readonly SlideId[],
): SlideId[] => outline.filter((id) => !excluded.includes(id));

/**
 * Adds a slide to the excluded list, or removes it when already excluded.
 *
 * @param excluded - The current excluded slides.
 * @param id - The slide to toggle.
 * @returns A new list in {@link SLIDE_IDS} order.
 */
export const toggleExcluded = (
  excluded: readonly SlideId[],
  id: SlideId,
): SlideId[] =>
  canonical(
    excluded.includes(id)
      ? excluded.filter((e) => e !== id)
      : [...excluded, id],
  );

/**
 * Reads the saved excluded slides, tolerating stale or corrupt storage.
 *
 * @param value - The parsed stored value.
 * @returns The valid, de-duplicated ids in {@link SLIDE_IDS} order, or `[]`
 * when the value is not an array.
 */
export const normaliseExcluded = (value: unknown): SlideId[] =>
  Array.isArray(value)
    ? SLIDE_IDS.filter((id) => (value as unknown[]).includes(id))
    : [];

/**
 * Tells whether the selection leaves anything to present.
 *
 * @param outline - The available slides.
 * @param excluded - The excluded slides.
 */
export const canStart = (
  outline: readonly SlideId[],
  excluded: readonly SlideId[],
): boolean => selectSlides(outline, excluded).length > 0;

/**
 * Picks the slide to show after the selection changes mid-presentation.
 *
 * Stays on the same slide, and the same page of a multi-page one, when it is
 * still in the deck; otherwise moves to the nearest following slide in
 * {@link SLIDE_IDS} order, else the last one.
 *
 * @param previous - Slide ids of the deck before the change, one per page.
 * @param index - Zero-based slide on show in the previous deck.
 * @param next - Slide ids of the new deck, one per page.
 * @returns A zero-based index into the new deck, or 0 when it is empty.
 */
export const landingSlide = (
  previous: readonly SlideId[],
  index: number,
  next: readonly SlideId[],
): number => {
  const id = previous[index];

  if (id === undefined || next.length === 0) return 0;
  const first = next.indexOf(id);

  if (first !== -1) {
    const pages = next.lastIndexOf(id) - first + 1;

    return first + Math.min(index - previous.indexOf(id), pages - 1);
  }
  const order = SLIDE_IDS.indexOf(id);
  const following = next.findIndex((n) => SLIDE_IDS.indexOf(n) > order);

  return following === -1 ? next.length - 1 : following;
};
