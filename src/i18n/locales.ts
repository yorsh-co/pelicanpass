/**
 * The locales the app can render.
 *
 * Imported by browser code as well as the server, so nothing here may read the
 * environment: which locales are offered is decided by the caller.
 */
export const LOCALES = ['pt-BR', 'en', 'en-XA'] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * The source locale. Its catalogs define every message and the types of every
 * message argument, and it is served whenever nothing else resolves.
 */
export const BASE_LOCALE: Locale = 'pt-BR';

/**
 * Accented, expanded and bracketed text generated from pt-BR. It exists to make
 * hardcoded, truncated and concatenated copy visible, and is never offered in
 * production.
 */
export const PSEUDO_LOCALE: Locale = 'en-XA';

/**
 * Locales being translated. They render in development, so translations can be
 * reviewed through `?lang=`, and are never offered in production. A locale
 * leaves this list only once every translatable message is translated;
 * `i18n:check` fails otherwise.
 */
export const DRAFT_LOCALES: readonly Locale[] = [];

/**
 * WhatsApp template language codes, which Meta spells with an underscore. A
 * locale without an entry has no approved template.
 */
export const META_LANGUAGE: Partial<Record<Locale, string>> = {
  'pt-BR': 'pt_BR',
};

/**
 * Reports whether a value names a known locale.
 *
 * @param value - Candidate, typically a cookie, query parameter or `lang`.
 */
export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

/**
 * The locales a deployment offers.
 *
 * @param nodeEnv - `NODE_ENV`. The pseudo-locale and draft locales are dropped
 *   in production.
 */
export const supportedLocales = (nodeEnv: string): readonly Locale[] =>
  nodeEnv === 'production'
    ? LOCALES.filter(
        (locale) => locale !== PSEUDO_LOCALE && !DRAFT_LOCALES.includes(locale),
      )
    : LOCALES;

/**
 * The locale dates and times are formatted in. English uses British
 * conventions — day-first dates and the 24-hour clock — to match pt-BR.
 *
 * @param locale - A BCP 47 tag, typically the page's or response's locale.
 * @returns `en-GB` for any English tag, otherwise the tag unchanged.
 */
export const dateTimeLocale = (locale: string): string =>
  new Intl.Locale(locale).language === 'en' ? 'en-GB' : locale;
