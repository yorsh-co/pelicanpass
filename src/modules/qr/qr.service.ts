/**
 * Extracts the check-in token from a scanned QR payload.
 *
 * Attendee QR codes encode a URL carrying the token in the `k` query
 * parameter, but the scanner also accepts a bare token pasted by hand, so a
 * payload that does not parse as a URL is returned as-is.
 *
 * @param qrCode - Raw scanned payload.
 * @returns The token, or `null` if the payload carries none.
 */
const extractToken = (qrCode: string): string | null => {
  if (!qrCode) return null;

  try {
    const url = new URL(qrCode);

    // An empty `k` counts as no token rather than as an empty one.
    const token = url.searchParams.get('k');

    return token === '' ? null : token;
  } catch {
    return qrCode;
  }
};

export const qrService = {
  extractToken,
};
