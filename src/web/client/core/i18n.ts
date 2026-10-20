import { BASE_LOCALE, isLocale } from '../../../i18n/locales.ts';

import type { Locale } from '../../../i18n/locales.ts';
import type { Namespace } from '../../../i18n/namespaces.ts';

/**
 * Builds a page's typed accessors from the catalog its route inlined.
 *
 * The locale is read from `<html lang>`: the server is the only writer of it.
 * The factory is passed in rather than looked up so that a page bundles its
 * own namespace and nothing else.
 *
 * @param ns - The namespace named in `<script data-i18n="…">`.
 * @param create - The namespace's generated `create…Messages` factory. Its
 *   catalog parameter is typed `never` so any namespace's factory is accepted;
 *   the catalog is the JSON the route serialised for that namespace.
 * @throws {Error} If the page carries no catalog for the namespace.
 */
export const readMessages = <Messages>(
  ns: Namespace,
  create: (locale: Locale, catalog: never) => Messages,
): Messages => {
  const el = document.querySelector(`script[data-i18n="${ns}"]`);

  if (!el) throw new Error(`missing inlined catalog: ${ns}`);

  const lang = document.documentElement.lang;

  return create(
    isLocale(lang) ? lang : BASE_LOCALE,
    JSON.parse(el.textContent) as never,
  );
};
