/** Entry tokens a landing URL can carry. */
export interface EntryTokens {
  /** A ticket link token, from a WhatsApp entry link (`?t=`). */
  t?: string;

  /** A poster QR token (`?k=`). */
  k?: string;
}

/**
 * Splits the entry tokens off a landing URL.
 *
 * A token is returned only when its parameter appears exactly once with a
 * value, the same rule `checkinEntryPost` applies: a repeated parameter is
 * treated as absent. Every `t` and `k` is stripped from `cleanPath` regardless,
 * so nothing token-shaped is left in the address bar.
 *
 * @param href - The full URL of the current page.
 * @returns The tokens held, and the path, query and hash to show in their place.
 */
export const readEntryTokens = (
  href: string,
): { tokens: EntryTokens; cleanPath: string } => {
  const url = new URL(href);
  const tokens: EntryTokens = {};

  for (const name of ['t', 'k'] as const) {
    const values = url.searchParams.getAll(name);
    const [value] = values;

    if (values.length === 1 && value) tokens[name] = value;

    url.searchParams.delete(name);
  }

  return { tokens, cleanPath: `${url.pathname}${url.search}${url.hash}` };
};
