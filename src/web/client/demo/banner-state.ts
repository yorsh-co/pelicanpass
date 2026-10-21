/**
 * Whether the demo banner shows its instructions or only its first line. The
 * choice is kept in `localStorage`, so it follows the visitor across pages and
 * survives the demo's reset, which clears only the `sessionStorage` state.
 */

/** The banner's two states, as written to `data-demo-banner` on `<html>`. */
export type BannerState = 'collapsed' | 'expanded';

/** Where the visitor's choice is kept. */
const STORAGE_KEY = 'pelicanpass-demo-banner-state:v1';

/** Viewports where the banner starts collapsed, so it does not fill a phone. */
const NARROW_QUERY = '(max-width: 40rem)';

const isBannerState = (value: unknown): value is BannerState =>
  value === 'collapsed' || value === 'expanded';

/**
 * Picks the banner's state.
 *
 * @param stored - The visitor's saved choice; anything but a state is ignored.
 * @param narrow - Whether the viewport is phone-sized.
 * @returns The saved choice, else collapsed on a narrow viewport and expanded
 *   on a wide one.
 */
export const bannerState = (
  stored: string | null,
  narrow: boolean,
): BannerState => {
  if (isBannerState(stored)) return stored;

  return narrow ? 'collapsed' : 'expanded';
};

/** Reads the saved choice, or `null` when none exists or storage is blocked. */
const readStored = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

/** Sets the state the stylesheet shows. */
const show = (state: BannerState): void => {
  document.documentElement.dataset.demoBanner = state;
};

/**
 * Sets `data-demo-banner` on `<html>` from the saved choice or the viewport.
 * Run it before first paint so the banner does not jump.
 */
export const applyBannerState = (): void => {
  show(bannerState(readStored(), window.matchMedia(NARROW_QUERY).matches));
};

/**
 * Shows the banner's toggle buttons, which the build renders hidden, one per
 * language, and makes each flip the banner and save the choice. Both buttons
 * keep `aria-expanded` in step, as either copy may be the one on screen.
 */
export const bindBannerToggle = (): void => {
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '[data-demo-banner-toggle]',
  );

  const sync = (): void => {
    const expanded =
      document.documentElement.dataset.demoBanner !== 'collapsed';

    for (const button of buttons) {
      button.setAttribute('aria-expanded', String(expanded));
    }
  };

  for (const button of buttons) {
    button.hidden = false;
    button.addEventListener('click', () => {
      const state: BannerState =
        document.documentElement.dataset.demoBanner === 'collapsed'
          ? 'expanded'
          : 'collapsed';

      show(state);
      sync();

      try {
        window.localStorage.setItem(STORAGE_KEY, state);
      } catch {
        // The choice still applies to this page.
      }
    });
  }

  sync();
};
