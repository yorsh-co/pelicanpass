/**
 * Single source of truth for the shape of an administrator username.
 *
 * A username is either a plain handle (`joshua`) or an email address
 * (`joshua@example.com`). Both are stored lowercased: case is not identity,
 * which `admins_username_lowercase_check` in `migrations/013_admins.ts`
 * enforces. That holds for the local part of an address too — RFC 5321 permits
 * a case-sensitive mailbox, but no mail provider an administrator would use
 * treats one as such, and two accounts differing only in case would look like
 * one in every listing.
 */

/** Shortest storable username, matching `admins_username_length_check`. */
export const ADMIN_USERNAME_MIN_LENGTH = 3;

/** Longest storable username, matching `admins_username_length_check`. */
export const ADMIN_USERNAME_MAX_LENGTH = 64;

/** A plain handle: lowercase alphanumerics, dot, underscore and hyphen. */
const HANDLE_RE = /^[a-z0-9._-]+$/;

/** The local part of an address, unquoted. */
const LOCAL_PART_RE = /^[a-z0-9._%+-]+$/;

/** One label of a domain name. Punycode (`xn--`) labels pass. */
const DOMAIN_LABEL_RE = /^[a-z0-9-]+$/;

/**
 * Reports whether a value is an email address, in a pragmatic subset of
 * RFC 5322: no quoted local parts, no IP literals, and at least one dot in the
 * domain.
 *
 * The domain is split into labels rather than matched by one repeated group,
 * which would be a nested quantifier.
 *
 * @param value - Normalised candidate address.
 */
const isEmailAddress = (value: string): boolean => {
  const at = value.indexOf('@');

  if (at <= 0) return false;

  const labels = value.slice(at + 1).split('.');

  return (
    LOCAL_PART_RE.test(value.slice(0, at)) &&
    labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL_RE.test(label))
  );
};

/**
 * Reports whether a value is a well-formed administrator username.
 *
 * Format only — it says nothing about whether the account exists.
 *
 * @param value - Normalised (trimmed, lowercased) candidate username.
 */
export const isAdminUsername = (value: string): boolean =>
  value.length >= ADMIN_USERNAME_MIN_LENGTH &&
  value.length <= ADMIN_USERNAME_MAX_LENGTH &&
  (HANDLE_RE.test(value) || isEmailAddress(value));
