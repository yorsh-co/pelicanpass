/**
 * Formatting options for the check-in moment on the pass.
 *
 * Formatted with `dateTimeLocale`, so English is day-first like pt-BR; the
 * time is always 24-hour. The month is abbreviated in English, where the
 * footer line is otherwise too long for the volunteer pass, and written out in
 * full elsewhere.
 *
 * @param lang - The page's BCP 47 language tag.
 * @returns Options for `Intl.DateTimeFormat`.
 */
export const checkinAtOptions = (lang: string): Intl.DateTimeFormatOptions => ({
  day: '2-digit',
  month: new Intl.Locale(lang).language === 'en' ? 'short' : 'long',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
