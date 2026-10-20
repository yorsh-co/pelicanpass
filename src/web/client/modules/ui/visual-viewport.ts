/**
 * Keeps the shell the size of the space the browser is actually showing.
 */

/**
 * How much of the viewport has to disappear before it counts as a keyboard.
 */
const KEYBOARD_THRESHOLD_PX = 150;

/**
 * Publishes `--viewport-height` and `body[data-keyboard]` from the visual
 * viewport.
 *
 * No teardown: the listener lives as long as the page, and the page is one
 * document per check-in.
 */
export const trackVisualViewport = (): void => {
  const viewport = window.visualViewport;

  if (!viewport) return;

  let frame = 0;

  const apply = () => {
    // A keyboard opening fires this many times over its animation; only the
    // last one per frame is worth writing to the DOM.
    cancelAnimationFrame(frame);

    frame = requestAnimationFrame(() => {
      document.documentElement.style.setProperty(
        '--viewport-height',
        `${String(viewport.height)}px`,
      );

      // The layout viewport does not shrink for a keyboard, so the difference
      // between the two is what the keyboard is covering.
      const covered = document.documentElement.clientHeight - viewport.height;

      document.body.dataset.keyboard =
        covered > KEYBOARD_THRESHOLD_PX ? 'open' : '';
    });
  };

  viewport.addEventListener('resize', apply);

  apply();
};
