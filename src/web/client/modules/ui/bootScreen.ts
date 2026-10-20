/**
 * Wraps the full-screen boot overlay in show/hide controls.
 *
 * @param el - The boot screen element.
 */
export const bootScreen = (el: HTMLElement) => {
  const show = () => {
    requestAnimationFrame(() => {
      el.classList.add('show');
    });
  };
  const hide = () => {
    requestAnimationFrame(() => {
      el.classList.remove('show');
    });
  };
  const transition = () => {
    if (el.classList.contains('show')) {
      requestAnimationFrame(() => {
        el.classList.remove('show');
      });
    } else {
      requestAnimationFrame(() => {
        el.classList.add('show');
      });
    }
  };

  return {
    show,
    hide,
    transition,
  };
};
