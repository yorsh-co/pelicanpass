import type { Locale } from '../i18n/locales.ts';

/**
 * The venue map the pass opens, by locale.
 *
 * The labels are text inside the SVG, so each language has a file of its own.
 * `en-XA` reuses the pt-BR map: the pseudo-locale is generated from pt-BR text,
 * and a drawing cannot be pseudo-translated.
 *
 * WARN: `/assets/images/` is cached for a week. Replace a map under a new file
 * name, and update `pass.map.alt` in every catalog in the same commit.
 */
export const VENUE_MAP_SRC: Record<Locale, string> = {
  'pt-BR': '/assets/images/map/venue-map.svg',
  en: '/assets/images/map/venue-map.en.svg',
  'en-XA': '/assets/images/map/venue-map.svg',
};
