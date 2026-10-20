/**
 * The light/dark toggle in `partials/footer.ejs`.
 *
 * Two states, not three. Until the first tap there is nothing stored and the OS
 * decides; after it the choice is explicit and sticky, which is the only model
 * a single unlabelled icon can express unambiguously.
 *
 * `partials/theme-boot.ejs` has already applied any stored choice to
 * `<html data-theme>` by the time this runs — module scripts are deferred, so
 * doing it here would flash. This module owns everything after first paint: the
 * button's appearance, the flip, and the browser-chrome colour.
 *
 * Its own build entry (`ENTRY_PATTERNS` in `scripts/build-client.ts`), loaded
 * by both layouts rather than by each page, so the wiring is not duplicated
 * across the check-in and pass bundles. `layouts/plain` loads it too, and
 * it is the only script those pages carry: the footer renders the button there
 * as well, and an inert one is worse than none.
 *
 * Deliberately not imported from `layouts/main/dom.ts`: that module builds its
 * frozen `layoutDom` with the throwing `qs()` at module load, so importing
 * anything from it would drag in the top bar's elements as a requirement.
 */

const STORAGE_KEY = 'theme';

type Theme = 'light' | 'dark';

/**
 * Icon ligature naming the theme a tap switches *to*, and the data attribute
 * on the toggle holding the matching label, which the server renders in the
 * page's locale.
 */
const TARGET = {
  light: { icon: 'dark_mode', label: 'labelDark' },
  dark: { icon: 'light_mode', label: 'labelLight' },
} as const;

/**
 * Resolves the theme in effect, preferring an explicit choice over the OS.
 *
 * @returns The active theme.
 */
const currentTheme = (): Theme => {
  const stored = document.documentElement.dataset.theme;

  if (stored === 'light' || stored === 'dark') return stored;

  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
};

/**
 * Points the button at the theme the next tap will produce.
 *
 * @param button - The toggle.
 * @param theme - The theme currently in effect.
 */
const paintButton = (button: HTMLButtonElement, theme: Theme): void => {
  const target = TARGET[theme];
  const icon = button.querySelector('.material-symbols-outlined');

  if (icon) icon.textContent = target.icon;

  const label = button.dataset[target.label];

  if (label) button.setAttribute('aria-label', label);
};

/**
 * Points the browser chrome at the theme in effect.
 *
 * Both layouts ship two `theme-color` metas gated on `prefers-color-scheme`,
 * which are right while the OS is in charge and wrong the moment it is not.
 * Once a choice exists they are replaced by a single unconditional meta —
 * one-directional, because a two-state toggle has no path back to OS control.
 *
 * The colour is read off the resolved page background rather than hardcoded a
 * third time. Reading `--canvas` would not work: a custom property computes to
 * its token stream, so it comes back as the literal `light-dark(…)` string.
 */
const syncThemeColor = (): void => {
  const canvas = getComputedStyle(document.body).backgroundColor;

  const override = document.head.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]:not([media])',
  );

  if (override) {
    override.content = canvas;

    return;
  }

  for (const meta of document.head.querySelectorAll('meta[name="theme-color"]'))
    meta.remove();

  const meta = document.createElement('meta');

  meta.name = 'theme-color';
  meta.content = canvas;
  document.head.append(meta);
};

/**
 * Wires the toggle and brings it into line with the theme already applied.
 *
 * Returns quietly when the button is absent: both layouts render the footer
 * today, but nothing stops a future page from loading this bundle without it.
 */
const setupThemeToggle = (): void => {
  const button = document.querySelector<HTMLButtonElement>(
    '[data-theme-toggle]',
  );

  if (!button) return;

  paintButton(button, currentTheme());

  button.onclick = () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';

    document.documentElement.dataset.theme = next;
    paintButton(button, next);
    syncThemeColor();

    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Safari private browsing. The theme still applies for this page view;
      // only remembering it fails, and that is not worth interrupting anyone
      // at the door for.
    }
  };

  if (document.documentElement.dataset.theme) syncThemeColor();
};

setupThemeToggle();
