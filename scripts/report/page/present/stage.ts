import { disposeCharts, mountCharts } from '../charts.ts';
import { el } from '../dom.ts';
import { state, update } from '../state.ts';
import { currentTheme, toggleTheme } from '../theme.ts';
import { themeToggle } from '../ui.ts';
import { slideFrame } from './frame.ts';
import {
  actionForClick,
  actionForKey,
  clampSlide,
  fitScale,
  navigate,
  slideHash,
} from '../../core/navigation.ts';
import { landingSlide } from '../../core/selection.ts';
import { openSlidePicker, slidePickerOpen } from './picker.ts';
import { buildDeck } from './slides.ts';

import type { Ctx } from '../ctx.ts';

/** Time without pointer movement before the controls and cursor hide. */
const IDLE_MS = 2000;

/** The running presentation, which the document-level keys act on. */
interface Session {
  index: number;
  count: number;
  go: (index: number) => void;
}

let session: Session | null = null;
let keysBound = false;

/** Toggles fullscreen; a refusal (unsupported, no gesture) is ignored. */
const toggleFullscreen = async (): Promise<void> => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // The presentation works windowed.
  }
};

/** Leaves presentation mode, and fullscreen with it. */
const exit = (): void => {
  if (document.fullscreenElement) void toggleFullscreen();
  update({ presenting: null });
};

const onKeyDown = (event: KeyboardEvent): void => {
  if (
    session === null ||
    state.presenting === null ||
    slidePickerOpen() ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) {
    return;
  }
  if (event.key === 'Escape') {
    exit();

    return;
  }
  const letter = event.key.toLowerCase();

  if (letter === 'f' || letter === 't') {
    if (letter === 'f') void toggleFullscreen();
    else toggleTheme();

    return;
  }
  const action = actionForKey(event.key);
  const target = event.target;

  if (action === null) return;
  // Enter and Space on a keyboard-focused control activate it, not the deck.
  if (
    (event.key === 'Enter' || event.key === ' ') &&
    target instanceof HTMLElement &&
    target.matches('button, a, select, input') &&
    target.matches(':focus-visible')
  ) {
    return;
  }
  event.preventDefault();
  session.go(navigate(action, session.index, session.count));
};

const button = (
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement =>
  el(
    'button',
    {
      class: 'pbtn',
      attrs: { type: 'button', title, 'aria-label': title },
      on: { click: onClick },
    },
    label,
  );

/**
 * Draws the presentation: the current slide scaled into the viewport, the
 * controls and the keyboard and click navigation.
 *
 * Replaces the whole page, so a theme change simply calls it again at the
 * same slide. The slide on show is `state.presenting`, clamped to the deck.
 *
 * @param ctx - The context the tabs use.
 * @returns The stage element, to attach before charts are mounted.
 */
export const presentation = (ctx: Ctx): HTMLElement => {
  const deck = buildDeck(ctx);
  const count = deck.length;
  const box = el('div', { class: 'pbox' });
  const announcer = el('div', {
    class: 'sr-only',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
  const counter = el('span', { class: 'pcounter' });
  const current: Session = {
    index: clampSlide(state.presenting ?? 0, count),
    count,
    go: (index) => {
      if (index !== current.index) show(index, true);
    },
  };

  const show = (index: number, mount: boolean): void => {
    const slide = deck[index];

    if (!slide) return;
    current.index = index;
    state.presenting = index;
    disposeCharts();
    box.replaceChildren(slideFrame(ctx, slide, slide.render(), index, count));
    counter.textContent = `${String(index + 1)} / ${String(count)}`;
    previous.setAttribute('aria-disabled', String(index === 0));
    next.setAttribute('aria-disabled', String(index === count - 1));
    announcer.textContent = `Slide ${String(index + 1)} de ${String(count)}: ${slide.title}`;
    history.replaceState(null, '', slideHash(index));
    if (mount) mountCharts(ctx.palette);
  };

  const previous = button('‹', 'Slide anterior', () => {
    current.go(navigate('prev', current.index, count));
  });
  const next = button('›', 'Próximo slide', () => {
    current.go(navigate('next', current.index, count));
  });
  const controls = el(
    'div',
    { class: 'pcontrols' },
    previous,
    counter,
    next,
    themeToggle(currentTheme(), toggleTheme),
    button('Slides', 'Escolher slides', () => {
      openSlidePicker(ctx, 'Aplicar', () => {
        update({
          presenting: landingSlide(
            deck.map((slide) => slide.id),
            current.index,
            buildDeck(ctx).map((slide) => slide.id),
          ),
        });
      });
    }),
    button('Tela cheia', 'Tela cheia (F)', () => {
      void toggleFullscreen();
    }),
    button('Sair', 'Sair (Esc)', exit),
  );
  const stage = el(
    'div',
    {
      class: 'pstage',
      attrs: {
        role: 'region',
        'aria-roledescription': 'apresentação',
        'aria-label': 'Apresentação do relatório',
      },
    },
    box,
    announcer,
    controls,
  );

  const scale = (width: number, height: number): void => {
    stage.style.setProperty('--s', String(fitScale(width, height)));
  };
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const wake = (): void => {
    stage.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stage.classList.add('idle');
    }, IDLE_MS);
  };

  scale(window.innerWidth, window.innerHeight);
  new ResizeObserver(() => {
    scale(stage.clientWidth, stage.clientHeight);
  }).observe(stage);
  stage.addEventListener('pointermove', wake);
  stage.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('.pcontrols')) {
      return;
    }
    const slide = box.getBoundingClientRect();
    const inside =
      event.clientX >= slide.left &&
      event.clientX <= slide.right &&
      event.clientY >= slide.top &&
      event.clientY <= slide.bottom;

    if (inside) {
      current.go(
        navigate(
          actionForClick(event.clientX, slide.left, slide.width),
          current.index,
          count,
        ),
      );
    }
  });
  if (!keysBound) {
    document.addEventListener('keydown', onKeyDown);
    keysBound = true;
  }
  session = current;
  show(current.index, false);
  wake();

  return stage;
};
