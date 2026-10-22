/**
 * Applies the demo's language routing to the page the visitor is on. The rules
 * are `routeLocale`'s in `./locale-route.ts`; this module reads the location and
 * `localStorage` and acts on the verdict.
 */

import { LOCALE_STORAGE_KEY, routeLocale } from './locale-route.ts';

import type { DemoLocale } from './locale-route.ts';

/** Reads the saved choice, or `null` when none exists or storage is blocked. */
const readStored = (): string | null => {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
};

/** Saves the choice; when storage is blocked it applies to this page only. */
const writeStored = (locale: DemoLocale): void => {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The choice still decides this page's tree.
  }
};

/**
 * Applies {@link routeLocale} to the current page: saves a `?lang=` choice,
 * drops the parameter with `history.replaceState`, or `location.replace()`s to
 * the other tree. Run it before first paint.
 *
 * With storage blocked there is no saved choice, so the browser's language
 * decides; the parameter is dropped either way, so the redirect cannot loop.
 *
 * @returns Whether the page is being left, so the caller can skip the rest of
 *   its setup.
 */
export const applyLocaleRoute = (): boolean => {
  const { pathname, search, hash } = window.location;
  const route = routeLocale({
    pathname,
    search,
    hash,
    stored: readStored(),
    browser: window.navigator.language,
  });

  if (route.save !== null) writeStored(route.save);

  if (route.url === null) return false;

  if (route.redirect) {
    window.location.replace(route.url);

    return true;
  }

  window.history.replaceState(window.history.state, '', route.url);

  return false;
};
