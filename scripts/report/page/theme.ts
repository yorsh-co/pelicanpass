import { THEME_STORAGE_KEY } from '../core/model.ts';

/** The two themes a viewer can choose. */
export type Theme = 'light' | 'dark';

/**
 * The theme in effect: an explicit choice on `<html data-theme>`, set by the
 * toggle or the host, else the OS preference.
 */
export const currentTheme = (): Theme => {
  const chosen = document.documentElement.dataset.theme;

  if (chosen === 'light' || chosen === 'dark') return chosen;

  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

/**
 * Switches to the other theme and remembers it. The page re-renders through
 * {@link watchTheme}, which observes the attribute this sets.
 */
export const toggleTheme = (): void => {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';

  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Storage blocked: the choice still applies to this view.
  }
};

/** Theme colours resolved to concrete values, for ECharts. */
export interface Palette {
  text: string;
  muted: string;
  border: string;
  borderStrong: string;
  surface: string;
  accent: string;
  success: string;
  warn: string;
  error: string;
  participant: string;
  volunteer: string;
}

const TOKENS: Readonly<Record<keyof Palette, string>> = {
  text: '--text',
  muted: '--text-muted',
  border: '--border',
  borderStrong: '--border-strong',
  surface: '--surface',
  accent: '--accent',
  success: '--success',
  warn: '--warn',
  error: '--error',
  participant: '--series-participant',
  volunteer: '--series-volunteer',
};

/**
 * Resolves the CSS tokens to colours.
 *
 * `getPropertyValue` returns `light-dark(...)` unresolved, so each token is
 * set as `color` on a hidden probe and read back from the computed style.
 */
export const resolvePalette = (): Palette => {
  const probe = document.createElement('span');

  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none';
  document.body.append(probe);
  const resolve = (token: string): string => {
    probe.style.color = `var(${token})`;

    return getComputedStyle(probe).color;
  };
  const palette = Object.fromEntries(
    Object.entries(TOKENS).map(([key, token]) => [key, resolve(token)]),
  ) as unknown as Palette;

  probe.remove();

  return palette;
};

/** Whether the user asked for less motion. */
export const prefersReducedMotion = (): boolean =>
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Calls back when the effective theme changes: the OS scheme or the host's
 * `data-theme` on `<html>`.
 *
 * @param callback - Called after each change.
 */
export const watchTheme = (callback: () => void): void => {
  matchMedia('(prefers-color-scheme: dark)').addEventListener(
    'change',
    callback,
  );
  new MutationObserver(callback).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
};
