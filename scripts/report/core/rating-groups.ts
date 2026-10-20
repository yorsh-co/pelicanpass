import { rankByMean } from './metrics.ts';

import type { RatingStat } from './metrics.ts';

/** Section of the event a participant rating question belongs to. */
export type RatingGroup = 'attractions' | 'structure';

/**
 * Group of each participant rating question, by question id. Add new rating
 * questions here; a test fails while one is missing.
 */
export const RATING_GROUPS: Readonly<Record<string, RatingGroup>> = {
  programme_rating: 'attractions',
  checkin_rating: 'structure',
  food_rating: 'structure',
  venue_rating: 'structure',
  communication_rating: 'structure',
};

const groupOf = (id: string): RatingGroup | undefined =>
  Object.hasOwn(RATING_GROUPS, id) ? RATING_GROUPS[id] : undefined;

/** Rating question that holds the overall score, shown on its own. */
const OVERALL = 'overall_rating';

/** Rating statistics split by {@link RATING_GROUPS}, best first. */
export interface GroupedRatings {
  attractions: RatingStat[];
  structure: RatingStat[];
  /** Questions missing from {@link RATING_GROUPS}. */
  other: RatingStat[];
}

/**
 * Splits rating statistics into attractions, event structure and the rest.
 * The overall score and questions without answers are left out.
 *
 * @param stats - Output of `ratingStats`.
 * @returns Each group ranked by mean, best first.
 */
export const groupRatings = (stats: readonly RatingStat[]): GroupedRatings => {
  const answered = stats.filter((s) => s.id !== OVERALL && s.n > 0);
  const inGroup = (group: RatingGroup | undefined): RatingStat[] =>
    rankByMean(answered.filter((s) => groupOf(s.id) === group));

  return {
    attractions: inGroup('attractions'),
    structure: inGroup('structure'),
    other: inGroup(undefined),
  };
};
