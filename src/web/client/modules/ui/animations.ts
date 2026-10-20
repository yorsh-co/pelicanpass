/**
 * Whether the viewer has asked for reduced motion.
 *
 * Read per call rather than cached: the preference can change while the page is
 * open, and a check-in page can sit on one step for minutes.
 *
 * The CSS reset neutralises declarative animations, but the Web Animations API
 * is untouched by it — a `prefers-reduced-motion` block cannot reach an
 * `el.animate()` call, so anything scripted has to ask for itself.
 */
export const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Nudges an element side to side, used to draw attention to a rejected input.
 *
 * @param el - Element to shake.
 */
const shake = (el: Element): void => {
  if (prefersReducedMotion()) return;

  el.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-5px)' },
      { transform: 'translateX(5px)' },
      { transform: 'translateX(-5px)' },
      { transform: 'translateX(0)' },
    ],
    {
      duration: 300,
      easing: 'ease',
    },
  );
};

const animate = {
  shake,
};
export default animate;
