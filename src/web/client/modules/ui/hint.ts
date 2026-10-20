import animate from './animations.ts';

const TRANSITION_DELAY = 120;

/** Kind of message a hint is currently displaying. */
type HintType = 'hint' | 'error';

/**
 * Version counter per hint element. Hints are replaced faster than they
 * animate, so each transition records which one it is and abandons its update
 * if a later call has superseded it.
 */
const hintVersions = new WeakMap<HTMLElement, number>();

/**
 * Fades a hint out, applies `updater`, and fades it back in.
 *
 * @param el - Hint element.
 * @param updater - Mutates the element's content while it is hidden.
 */
const runTransition = (el: HTMLElement, updater: () => void): Promise<void> =>
  new Promise((resolve) => {
    const version = (hintVersions.get(el) ?? 0) + 1;
    hintVersions.set(el, version);

    el.classList.add('changing');

    setTimeout(() => {
      if (hintVersions.get(el) !== version) {
        resolve();
        return;
      }

      updater();

      requestAnimationFrame(() => {
        el.classList.remove('changing');
      });

      resolve();
    }, TRANSITION_DELAY);
  });

const set = (
  el: HTMLElement,
  { text = '', type = 'hint' }: { text?: string; type?: HintType } = {},
): Promise<void> =>
  runTransition(el, () => {
    el.textContent = text;

    el.classList.toggle('error', type === 'error');

    el.dataset.hintState = type;
  });

const clear = (el: HTMLElement): Promise<void> =>
  runTransition(el, () => {
    el.textContent = '';
    el.classList.remove('error');

    el.dataset.hintState = '';
  });

const shake = (el: HTMLElement): void => {
  animate.shake(el);
};

const hint = {
  set,
  clear,
  shake,

  showHint: (el: HTMLElement, msg: string): Promise<void> =>
    set(el, { text: msg, type: 'hint' }),

  showError: async (el: HTMLElement, msg: string): Promise<void> => {
    await set(el, { text: msg, type: 'error' });
    animate.shake(el);
  },

  change: (el: HTMLElement, msg: string): Promise<void> =>
    set(el, { text: msg }),
};

export default hint;
