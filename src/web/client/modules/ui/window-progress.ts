import { PASS_WINDOW_MS } from '../../../../constants/pass.ts';

/**
 * Draws how much of the current rotation window is left.
 *
 * Shared by the attendee's pass and the volunteer's band block for the same
 * reason the clock formatter is: the two bars are read side by side across a
 * counter, and both derive from the same server-issued window, so they should
 * sit at the same level. Two copies of this geometry would agree until one of
 * them was edited.
 *
 * The value rides on a custom property rather than an inline `width`, so the
 * geometry stays in the stylesheet with everything else.
 *
 * @param el - The bar's container.
 * @param remainingMs - Time left in the window, from the caller's own
 *   `performance.now()` reckoning.
 */
export const renderWindowProgress = (
  el: HTMLElement,
  remainingMs: number,
): void => {
  // Clamped, never wrapped. A window that ends with no refresh behind it leaves
  // the bar empty and keeps it there — unlike a clock, which goes on looking
  // healthy off the device's own time, a drained bar cannot report a dead loop
  // as a live one.
  const remaining = Math.min(Math.max(remainingMs, 0), PASS_WINDOW_MS);

  el.style.setProperty(
    '--window-remaining',
    String(remaining / PASS_WINDOW_MS),
  );
};
