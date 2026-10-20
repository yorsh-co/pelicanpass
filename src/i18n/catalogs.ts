import { CATALOGS, MESSAGES } from './generated/registry.ts';

import type { MessagesOf, RegisteredNamespace } from './generated/registry.ts';
import type { Locale } from './locales.ts';

/**
 * Typed message accessors and inlined catalogs.
 *
 * Free of the environment on purpose: `server.ts` resolves which locales a
 * deployment offers from `env`, and the standalone landing fallback renders
 * the same pages without the secrets that module requires.
 */

const messagesCache = new Map<string, unknown>();

/**
 * Typed accessors for one namespace, memoised per locale so each message is
 * compiled once per process.
 *
 * @param locale - Usually `res.locals.locale`.
 * @param ns - The page's namespace.
 */
export const getMessages = <N extends RegisteredNamespace>(
  locale: Locale,
  ns: N,
): MessagesOf[N] => {
  const key = `${locale}:${ns}`;
  const cached = messagesCache.get(key) as MessagesOf[N] | undefined;

  if (cached) return cached;

  const messages = MESSAGES[ns](locale);
  messagesCache.set(key, messages);

  return messages;
};

/** Folds a union of object types into one type carrying every member. */
type Merged<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;

const copyCache = new Map<string, unknown>();

/**
 * The accessors of several namespaces as one object, for a template's `copy`
 * local.
 *
 * The template names the same namespaces in its `<%# i18n: … %>` header, and
 * `i18n:check` fails if two of them define the same accessor.
 *
 * @param locale - Usually `res.locals.locale`.
 * @param namespaces - Every namespace the template reads through `copy`.
 */
export const getCopy = <N extends RegisteredNamespace>(
  locale: Locale,
  namespaces: readonly N[],
): Merged<MessagesOf[N]> => {
  const key = `${locale}:${namespaces.join(',')}`;
  const cached = copyCache.get(key) as Merged<MessagesOf[N]> | undefined;

  if (cached) return cached;

  const copy = Object.assign(
    {},
    ...namespaces.map((ns) => getMessages(locale, ns)),
  ) as Merged<MessagesOf[N]>;
  copyCache.set(key, copy);

  return copy;
};

/**
 * The compiled catalogs a page reads in the browser, for
 * `partials/i18n-catalogs.ejs`.
 *
 * Each entry pairs a namespace with its catalog as JSON, escaped so it is safe
 * inside a `<script type="application/json">` block with an unescaped EJS tag.
 *
 * @param locale - Usually `res.locals.locale`.
 * @param namespaces - Every namespace the page's script reads.
 */
export const inlineCatalogs = (
  locale: Locale,
  namespaces: readonly RegisteredNamespace[],
): [RegisteredNamespace, string][] =>
  namespaces.map((ns) => [
    ns,
    JSON.stringify(CATALOGS[ns][locale]).replace(/</g, '\\u003c'),
  ]);
