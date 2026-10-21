/**
 * Language of the demo banner, the only part of the demo page that is
 * translated. The choice is kept in `localStorage`, so it follows the visitor
 * across pages and survives the demo's reset, which clears only the
 * `sessionStorage` state.
 */

/** The languages the banner is written in. */
export type BannerLanguage = 'pt' | 'en';

/** Where the visitor's choice is kept. */
const STORAGE_KEY = 'pelicanpass-demo-banner-lang:v1';

const isBannerLanguage = (value: unknown): value is BannerLanguage =>
  value === 'pt' || value === 'en';

/**
 * Picks the banner's language.
 *
 * @param stored - The visitor's saved choice; anything but `pt` or `en` is ignored.
 * @param browser - The browser's preferred language, such as `pt-BR`.
 * @returns The saved choice, else Portuguese for a Portuguese or unknown
 *   browser (the app's own language), else English.
 */
export const bannerLanguage = (
  stored: string | null,
  browser: string | undefined,
): BannerLanguage => {
  if (isBannerLanguage(stored)) return stored;

  return browser === undefined ||
    browser === '' ||
    browser.toLowerCase().startsWith('pt')
    ? 'pt'
    : 'en';
};

/** Reads the saved choice, or `null` when none exists or storage is blocked. */
const readStored = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

/** Sets the language the stylesheet shows. */
const show = (language: BannerLanguage): void => {
  document.documentElement.dataset.demoLang = language;
};

/**
 * Sets `data-demo-lang` on `<html>` from the saved choice or the browser's
 * language. Run it before first paint so the banner does not flash.
 */
export const applyBannerLanguage = (): void => {
  show(bannerLanguage(readStored(), window.navigator.language));
};

/**
 * Shows the banner's language buttons, which the build renders hidden, and
 * makes each switch the banner to its language and save the choice. Focus moves
 * to the other copy's button, as the one clicked is hidden by the switch.
 */
export const bindBannerLanguage = (): void => {
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '[data-demo-set-lang]',
  );

  for (const button of buttons) {
    button.hidden = false;
    button.addEventListener('click', () => {
      const language = button.dataset.demoSetLang;

      if (!isBannerLanguage(language)) return;

      show(language);

      try {
        window.localStorage.setItem(STORAGE_KEY, language);
      } catch {
        // The choice still applies to this page.
      }

      document
        .querySelector<HTMLButtonElement>(
          `[data-demo-copy='${language}'] [data-demo-set-lang]`,
        )
        ?.focus();
    });
  }
};
