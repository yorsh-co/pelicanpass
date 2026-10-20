import { SLIDE_IDS } from '../../core/deck.ts';
import { canStart, toggleExcluded } from '../../core/selection.ts';
import { el } from '../dom.ts';
import { persistSlides, state } from '../state.ts';
import { slideChoices } from './slides.ts';

import type { SlideId } from '../../core/deck.ts';
import type { Ctx } from '../ctx.ts';

/** Tells whether the slide picker is on screen. */
export const slidePickerOpen = (): boolean =>
  document.querySelector('dialog.picker[open]') !== null;

/**
 * Opens the "Escolher slides" dialog.
 *
 * Each toggle is saved as it happens. Closing the dialog any way other than
 * the confirm button restores the selection it opened with.
 *
 * @param ctx - The context the tabs use.
 * @param confirmLabel - Text of the primary button.
 * @param onConfirm - Called after the dialog closes on confirm; the selection
 * is already in `state.excludedSlides`.
 */
export const openSlidePicker = (
  ctx: Ctx,
  confirmLabel: string,
  onConfirm: () => void,
): void => {
  if (slidePickerOpen()) return;
  const choices = slideChoices(ctx);
  const outline = choices.map((c) => c.id);
  const initial = state.excludedSlides;
  const boxes = new Map<SlideId, HTMLInputElement>();
  const confirm = el(
    'button',
    { class: 'button primary', attrs: { type: 'button' } },
    confirmLabel,
  );
  const dialog = el('dialog', {
    class: 'picker',
    attrs: { 'aria-labelledby': 'picker-title' },
  });

  const sync = (): void => {
    for (const [id, box] of boxes) {
      box.checked = !state.excludedSlides.includes(id);
    }
    confirm.disabled = !canStart(outline, state.excludedSlides);
  };
  const setExcluded = (excluded: SlideId[]): void => {
    state.excludedSlides = excluded;
    persistSlides();
    sync();
  };
  const shortcut = (label: string, onClick: () => void): HTMLElement =>
    el(
      'button',
      {
        class: 'link-button',
        attrs: { type: 'button' },
        on: { click: onClick },
      },
      label,
    );

  const rows = choices.map(({ id, eyebrow, title }, i) => {
    const box = el('input', {
      attrs: { type: 'checkbox', ...(i === 0 ? { autofocus: '' } : {}) },
      on: {
        change: () => {
          setExcluded(toggleExcluded(state.excludedSlides, id));
        },
      },
    });

    boxes.set(id, box);

    return el(
      'li',
      {},
      el(
        'label',
        { class: 'picker-row' },
        box,
        el('span', {}, eyebrow === null ? title : `${eyebrow} · ${title}`),
      ),
    );
  });

  confirm.addEventListener('click', () => {
    dialog.close('confirm');
  });
  dialog.addEventListener('close', () => {
    const confirmed = dialog.returnValue === 'confirm';

    dialog.remove();
    if (confirmed) {
      onConfirm();
    } else {
      state.excludedSlides = initial;
      persistSlides();
    }
  });
  dialog.append(
    el(
      'h2',
      { class: 'picker-title', attrs: { id: 'picker-title' } },
      'Escolher slides',
    ),
    el(
      'div',
      { class: 'picker-shortcuts' },
      shortcut('Todos', () => {
        setExcluded(state.excludedSlides.filter((id) => !outline.includes(id)));
      }),
      shortcut('Nenhum', () => {
        setExcluded(
          SLIDE_IDS.filter(
            (id) => outline.includes(id) || state.excludedSlides.includes(id),
          ),
        );
      }),
    ),
    el('ul', { class: 'picker-list' }, ...rows),
    el(
      'div',
      { class: 'picker-actions' },
      el(
        'button',
        {
          class: 'button',
          attrs: { type: 'button' },
          on: {
            click: () => {
              dialog.close('cancel');
            },
          },
        },
        'Cancelar',
      ),
      confirm,
    ),
  );
  sync();
  document.body.append(dialog);
  dialog.showModal();
};
