/**
 * Path and query of a parsed URL, with any run of leading slashes or
 * backslashes collapsed to one `/`, so the result is never a protocol-relative
 * reference when used as a `Location`.
 *
 * @param url - A URL parsed against the placeholder origin.
 */
const localPath = (url: URL): string =>
  `${url.pathname.replace(/^[/\\]+/, '/')}${url.search}`;

/**
 * Drops one query parameter from a URL, keeping everything else.
 *
 * Used where a parameter is exchanged for a cookie and the request redirected,
 * so shared and QR links stay clean. Only the path and query are returned, so
 * the placeholder origin never escapes, and the path always starts with a
 * single `/`.
 *
 * @param originalUrl - `req.originalUrl`, path and query.
 * @param name - The parameter to remove.
 */
export const withoutQueryParam = (
  originalUrl: string,
  name: string,
): string => {
  const url = new URL(originalUrl, 'http://placeholder');

  url.searchParams.delete(name);

  return localPath(url);
};

/**
 * Sets one query parameter on a URL, keeping everything else.
 *
 * Only the path and query are returned, so the link stays relative to the
 * current origin, and the path always starts with a single `/`.
 *
 * @param originalUrl - `req.originalUrl`, path and query.
 * @param name - The parameter to set.
 * @param value - Its value, replacing any existing one.
 */
export const withQueryParam = (
  originalUrl: string,
  name: string,
  value: string,
): string => {
  const url = new URL(originalUrl, 'http://placeholder');

  url.searchParams.set(name, value);

  return localPath(url);
};
