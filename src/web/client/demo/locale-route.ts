/**
 * Which of the demo's two page trees a visitor belongs in. Pure and free of the
 * DOM, so the demo build can share it; `./apply-locale-route.ts` acts on it.
 *
 * The demo is static files with no server to negotiate a language, so each page
 * exists twice: pt-BR at its own path and English under `/en`. The mock script
 * runs `applyLocaleRoute` first thing in `<head>`, before paint, so the visitor
 * is moved to the right tree before the wrong one is seen. That also catches
 * the app's own root-absolute navigations, such as check-in sending the visitor
 * to `/pass`.
 *
 * The choice is kept in `localStorage`, so it follows the visitor across pages
 * and survives the demo's reset, which clears only the `sessionStorage` state.
 */

import type { Locale } from '../../../i18n/locales.ts';

/**
 * The locales the demo offers: the production ones, without the pseudo-locale.
 * `scripts/demo/build.ts` fails when this list and the app's drift apart.
 */
export const DEMO_LOCALES = [
  'pt-BR',
  'en',
] as const satisfies readonly Locale[];

/** One of {@link DEMO_LOCALES}. */
export type DemoLocale = (typeof DEMO_LOCALES)[number];

/** Where the visitor's choice is kept. */
export const LOCALE_STORAGE_KEY = 'pelicanpass-demo-locale:v1';

/** The query parameter that sets the choice, as in the app. */
const LANG_PARAM = 'lang';

/** Path prefix of the English tree; pt-BR has none. */
const ENGLISH_PREFIX = '/en';

/**
 * Reports whether a value names a demo locale.
 *
 * @param value - Candidate, typically a query parameter or stored string.
 */
export const isDemoLocale = (value: unknown): value is DemoLocale =>
  typeof value === 'string' &&
  (DEMO_LOCALES as readonly string[]).includes(value);

/**
 * Collapses leading slashes and backslashes to one `/`, so a path built from
 * `/en//host` can never become a protocol-relative URL when used as a location.
 */
const rooted = (path: string): string => path.replace(/^[/\\]+/, '/');

/**
 * The tree a path is served from.
 *
 * @param pathname - `location.pathname`.
 */
export const treeOf = (pathname: string): DemoLocale =>
  pathname === ENGLISH_PREFIX || pathname.startsWith(`${ENGLISH_PREFIX}/`)
    ? 'en'
    : 'pt-BR';

/**
 * The path with its tree prefix removed, so `/en/pass` and `/pass` both give
 * `/pass` and `/en/` gives `/`.
 *
 * @param pathname - A path from either tree.
 */
export const stripTree = (pathname: string): string =>
  treeOf(pathname) === 'en'
    ? rooted(pathname.slice(ENGLISH_PREFIX.length) || '/')
    : rooted(pathname);

/**
 * Moves a path into a tree: `/x` becomes `/en/x` for English, `/` becomes
 * `/en/`, and an English path becomes its pt-BR counterpart for pt-BR.
 *
 * @param pathname - A path from either tree.
 * @param locale - The tree to put it in.
 */
export const inTree = (pathname: string, locale: DemoLocale): string => {
  const plain = stripTree(pathname);

  if (locale !== 'en') return plain;

  return plain === '/' ? `${ENGLISH_PREFIX}/` : `${ENGLISH_PREFIX}${plain}`;
};

/**
 * Moves a root-absolute URL, with its query and hash, into a tree; anything
 * else (relative, protocol-relative, absolute) is returned as it is.
 *
 * @param url - A URL such as the app passes to `history.replaceState`.
 * @param locale - The tree to put it in.
 */
export const urlInTree = (url: string, locale: DemoLocale): string => {
  if (!url.startsWith('/') || url.startsWith('//')) return url;

  const at = url.search(/[?#]/);

  return at === -1
    ? inTree(url, locale)
    : `${inTree(url.slice(0, at), locale)}${url.slice(at)}`;
};

/** What {@link routeLocale} reads. */
export interface LocaleRouteInput {
  /** `location.pathname`. */
  pathname: string;

  /** `location.search`, with its `?` or empty. */
  search: string;

  /** `location.hash`, with its `#` or empty. */
  hash: string;

  /** The visitor's saved choice; anything but a demo locale is ignored. */
  stored: string | null;

  /** The browser's preferred language, such as `pt-BR`. */
  browser: string | undefined;
}

/** What {@link routeLocale} decided. */
export interface LocaleRoute {
  /** The language the visitor should see. */
  locale: DemoLocale;

  /** The choice to save: set only when the URL carried a valid `?lang=`. */
  save: DemoLocale | null;

  /**
   * Path, query and hash the page should be at, with `lang` dropped, or `null`
   * when the current URL is already right.
   */
  url: string | null;

  /** Whether `url` is in another tree, so the page must be left, not rewritten. */
  redirect: boolean;
}

/**
 * Decides the visitor's language and where they should be for it.
 *
 * In order: a valid `?lang=` is the choice, to be saved and dropped from the
 * URL; otherwise the saved choice; otherwise a browser language starting with
 * `pt`, or none, gives pt-BR, and anything else English. A path in the other
 * tree is mapped to the same path, query and hash in the right one. An
 * unsupported `?lang=` is left alone, as the app leaves it.
 *
 * Pure: the caller reads storage and the location, and acts on the result.
 *
 * @param input - See {@link LocaleRouteInput}.
 */
export const routeLocale = ({
  pathname,
  search,
  hash,
  stored,
  browser,
}: LocaleRouteInput): LocaleRoute => {
  const params = new URLSearchParams(search);
  const asked = params.get(LANG_PARAM);
  const save = isDemoLocale(asked) ? asked : null;

  const locale =
    save ??
    (isDemoLocale(stored)
      ? stored
      : browser === undefined ||
          browser === '' ||
          browser.toLowerCase().startsWith('pt')
        ? 'pt-BR'
        : 'en');

  const path =
    treeOf(pathname) === locale ? pathname : inTree(pathname, locale);
  let query = search;

  if (save !== null) {
    params.delete(LANG_PARAM);

    const rest = params.toString();

    query = rest === '' ? '' : `?${rest}`;
  }

  const url = `${path}${query}${hash}`;

  return {
    locale,
    save,
    url: url === `${pathname}${search}${hash}` ? null : url,
    redirect: path !== pathname,
  };
};

/**
 * The tree the current page is in, for code that must stay in it.
 *
 * @param pathname - `location.pathname`.
 * @param path - A plain, pt-BR-tree path such as `/checkin`.
 */
export const localizedPath = (pathname: string, path: string): string =>
  inTree(path, treeOf(pathname));
