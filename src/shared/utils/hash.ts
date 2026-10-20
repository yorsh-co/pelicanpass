import crypto from 'crypto';

/**
 * Hashes a User-Agent string for session binding.
 *
 * Callers read straight from `req.headers['user-agent']`, which is absent on
 * requests that send no UA, so a missing value hashes as the empty string
 * rather than throwing.
 *
 * @param ua - Raw User-Agent header value, if the request carried one.
 * @returns Hex-encoded SHA-256 digest.
 */
export const hashUA = (ua: string | undefined): string =>
  crypto
    .createHash('sha256')
    .update(ua ?? '')
    .digest('hex');

/**
 * Hashes a value for storage, so the plaintext never reaches Redis.
 *
 * Used by `session.service.ts` to derive key names from session IDs, so the
 * keyspace holds digests rather than live IDs. A bare SHA-256 is enough there
 * because a session ID is a v4 UUID — 122 random bits, no structure to guess.
 *
 * **Not suitable for low-entropy values.** It once digested the last four
 * digits of a phone number, a 10,000-candidate space that a lookup table
 * defeats outright — see `verifyAttendee` in checkin.service.ts.
 *
 * @param value - Value to hash.
 * @returns Hex-encoded SHA-256 digest.
 */
export const hash = (value: string): string => {
  return crypto.createHash('sha256').update(value).digest('hex');
};
