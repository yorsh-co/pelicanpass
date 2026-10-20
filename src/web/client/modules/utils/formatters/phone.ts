/** Locales `formatPhone.locale` has a formatter for. */
type PhoneLocale = 'pt-BR';

const LOCALE_FORMATTERS: Record<PhoneLocale, (phone: string) => string> = {
  'pt-BR': (phone) => {
    if (!phone) return '';

    let digits = phone.replace(/\D/g, '');

    if (digits.startsWith('55')) digits = digits.slice(2);

    const ddd = digits.slice(0, 2);
    const number = digits.slice(2);

    // If no DDD yet, just return masked partial
    if (digits.length <= 2) {
      return `(${ddd}${'•'.repeat(2 - ddd.length)}) ••••-••••`;
    }

    // Validate DDD when complete
    if (ddd.length === 2 && !/^[1-9][0-9]$/.test(ddd)) {
      return phone;
    }

    // Decide type (mobile vs landline)
    const isMobile = number.startsWith('9') || number.length > 8;

    const maxLen = isMobile ? 9 : 8;
    const padded = (number + '•'.repeat(maxLen)).slice(0, maxLen);

    if (isMobile) {
      return `(${ddd}) ${padded.slice(0, 5)}-${padded.slice(5)}`;
    }

    return `(${ddd}) ${padded.slice(0, 4)}-${padded.slice(4)}`;
  },
};

/**
 * Formats a phone number for a specific locale, masking the digits the user
 * has not typed yet so the field keeps its full shape while being filled.
 *
 * `locale` is a union rather than a string because the lookup below is
 * unguarded: an unknown locale would call `undefined` on every keystroke.
 *
 * @param phone - Raw input, digits and punctuation in any arrangement.
 * @param locale - Which formatter to apply.
 */
const formatLocalePhone = (phone: string, locale: PhoneLocale): string =>
  LOCALE_FORMATTERS[locale](phone);

/**
 * Formats a phone number with no locale assumption, masking to a fixed width.
 *
 * @param phone - Raw input, digits and punctuation in any arrangement.
 */
const formatInternationalPhone = (phone: string): string => {
  if (!phone) return '';

  const digits = phone.replace(/\D/g, '');

  if (!digits) return phone;

  // Pad to minimum (10 digits: 2 DDD + 8 number)
  const padded = (digits + '•'.repeat(13)).slice(0, 13);

  return '+' + padded;
};

export const formatPhone = {
  locale: formatLocalePhone,
  international: formatInternationalPhone,
};
