/**
 * Shortest and longest stored value this normaliser will read for numbers
 * without a `+`, and so for the Brazilian rules.
 *
 * Narrower than `readPhone` in admin.attendees.service.ts, which accepts 10-15
 * digits on the way *into* the database. That function cleans typed input; this
 * one answers a different question — whether what is already stored can be sent
 * to Meta without guessing — and the answer for 14 or 15 digits is no.
 */
const MIN_DIGITS = 10;
const MAX_DIGITS = 13;

/** E.164's ceiling: a country code plus subscriber number is at most 15 digits. */
const MAX_INTERNATIONAL_DIGITS = 15;

/** Lowest and highest plausible Brazilian area code. */
const MIN_DDD = 11;
const MAX_DDD = 99;

/**
 * Why a stored number could not be sent.
 *
 * Distinct reasons rather than a bare `false` because the preview puts the
 * count on screen and each one sends the operator somewhere different in the
 * attendees editor: `length` is a truncated or padded record, `ddd` is usually
 * a country code typed twice, `unqualified` is a foreign number stored without
 * its `+`, fixed by retyping it with a `+` and the country code.
 */
export type E164Refusal = 'empty' | 'length' | 'ddd' | 'unqualified';

/** Outcome of normalising one stored phone number. */
export type E164Result =
  { ok: true; e164: string } | { ok: false; reason: E164Refusal };

/**
 * Reads the area code out of a number that has already been length-checked.
 *
 * @param digits - The number, digits only.
 * @param offset - How many leading digits belong to the country code.
 * @returns The two-digit area code as a number.
 */
const dddOf = (digits: string, offset: number): number =>
  Number(digits.slice(offset, offset + 2));

/**
 * Renders a stored phone number as E.164 without a `+`, as Meta wants it.
 *
 * A stored value starting with `+` already carries its country code. Under the
 * default country code it follows the Brazilian rules below, except that 10 or
 * 11 digits are refused as `length` instead of gaining a second prefix. Under
 * any other country code it is accepted at 10-15 digits with no area-code
 * check, since those rules are Brazil's.
 *
 * Without a `+`, four rules and no more. 10 or 11 digits are a bare area code
 * plus a landline or a nine-digit mobile, and take the country code prefix. 12
 * or 13 digits already carrying the country code pass through untouched. The
 * area code has to be plausible. **Everything else is refused rather than repaired.**
 *
 * **Never add or strip a ninth digit.** Mobiles registered before ANATEL's
 * rollout can still hold an eight-digit `wa_id` outside area codes 11-19, 21,
 * 22, 24, 27 and 28, so a number that looks short may be correct and a number
 * that looks right may canonicalise elsewhere. Guessing produces exactly the
 * misdelivery it is meant to prevent. Send what the roster holds, and let the
 * `wa_id` that comes back be the diagnostic.
 *
 * **A refusal is not a send-time error.** It becomes a `skipped` row and a
 * figure in the preview, so the operator repairs those records in the attendees
 * editor *before* starting a run rather than discovering them during one.
 *
 * Meta's documentation warns that a number sent without a country code has the
 * *business* number's country code prepended, "which can result in undelivered
 * or misdelivered messages". That is why the prefix is always supplied here and
 * never left to Meta to infer.
 *
 * @param stored - The number as held on the attendee record. Punctuation is
 *   tolerated, since nothing guarantees every historical row went through
 *   `readPhone`.
 * @param countryCode - Digits to prefix onto an unqualified number, and the
 *   country code whose numbers get the Brazilian checks.
 * @returns The number ready for the `to` field, or why it was refused.
 */
export const toE164 = (stored: string, countryCode: string): E164Result => {
  const international = stored.trimStart().startsWith('+');
  const digits = stored.replace(/\D/g, '');

  if (digits.length === 0) return { ok: false, reason: 'empty' };

  if (international && !digits.startsWith(countryCode)) {
    return digits.length < MIN_DIGITS ||
      digits.length > MAX_INTERNATIONAL_DIGITS
      ? { ok: false, reason: 'length' }
      : { ok: true, e164: digits };
  }

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
    return { ok: false, reason: 'length' };
  }

  const qualified = digits.length > 11;

  if (international && !qualified) return { ok: false, reason: 'length' };

  if (qualified && !digits.startsWith(countryCode)) {
    return { ok: false, reason: 'unqualified' };
  }

  const ddd = dddOf(digits, qualified ? countryCode.length : 0);

  if (ddd < MIN_DDD || ddd > MAX_DDD) {
    return { ok: false, reason: 'ddd' };
  }

  return { ok: true, e164: qualified ? digits : `${countryCode}${digits}` };
};
