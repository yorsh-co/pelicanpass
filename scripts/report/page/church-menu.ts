import {
  churchSelectionLabel,
  DEFAULT_FILTERS,
  excludeAllBut,
  toggleChurch,
} from '../core/filter.ts';
import { churchKey } from '../core/metrics.ts';
import { el } from './dom.ts';
import { state, update } from './state.ts';

const TRIGGER_FOCUS = 'church-menu';
const PANEL_ID = 'church-menu-panel';

/** Whether the panel is open; kept here so a re-render rebuilds it open. */
let open = false;

/** Scroll of the church list, restored when a re-render rebuilds it. */
let listScroll = 0;

const setExcluded = (excludedChurches: readonly string[]): void => {
  update({ filters: { ...state.filters, excludedChurches } });
};

const focusTrigger = (): void => {
  [...document.querySelectorAll<HTMLElement>('[data-focus]')]
    .find((n) => n.dataset.focus === TRIGGER_FOCUS)
    ?.focus({ preventScroll: true });
};

const close = (): void => {
  open = false;
  update({});
};

document.addEventListener('keydown', (event) => {
  if (!open || event.key !== 'Escape') return;
  close();
  focusTrigger();
});

document.addEventListener('click', (event) => {
  if (
    open &&
    !(event.target instanceof Element && event.target.closest('.church-menu'))
  ) {
    close();
  }
});

/**
 * The church filter: a button that opens a panel with one checkbox per
 * church (checked = included) and shortcuts. Changes apply as they happen.
 *
 * @param names - Every church in the data, largest first.
 */
export const churchMenu = (names: readonly string[]): HTMLElement => {
  const excluded = new Set(state.filters.excludedChurches.map(churchKey));
  const label = churchSelectionLabel(state.filters.excludedChurches, names);

  const trigger = el(
    'button',
    {
      class: 'menu-trigger',
      attrs: {
        type: 'button',
        id: 'church-menu-button',
        title: label.full,
        'aria-haspopup': 'true',
        'aria-expanded': String(open),
        'aria-controls': PANEL_ID,
        'aria-labelledby': 'church-menu-label church-menu-button',
        'data-focus': TRIGGER_FOCUS,
      },
      on: {
        click: () => {
          open = !open;
          listScroll = 0;
          update({});
          focusTrigger();
        },
      },
    },
    el('span', { class: 'menu-text' }, label.text),
  );
  const anchor = el('div', { class: 'menu-anchor' }, trigger);
  const field = el(
    'div',
    { class: 'field church-menu' },
    el('span', { attrs: { id: 'church-menu-label' } }, 'Igrejas'),
    anchor,
  );

  if (!open) return field;

  const shortcut = (text: string, value: readonly string[]): HTMLElement =>
    el(
      'button',
      {
        class: 'link-button',
        attrs: { type: 'button' },
        on: {
          click: () => {
            setExcluded(value);
          },
        },
      },
      text,
    );
  const list = el(
    'div',
    {
      class: 'menu-list',
      attrs: { role: 'group', 'aria-label': 'Igrejas incluídas' },
      on: {
        scroll: () => {
          listScroll = list.scrollTop;
        },
      },
    },
    ...names.map((name) =>
      el(
        'label',
        { class: 'menu-row' },
        el('input', {
          attrs: {
            type: 'checkbox',
            'data-focus': `church:${churchKey(name)}`,
            ...(excluded.has(churchKey(name)) ? {} : { checked: '' }),
          },
          on: {
            change: () => {
              setExcluded(toggleChurch(state.filters.excludedChurches, name));
            },
          },
        }),
        el('span', {}, name),
      ),
    ),
  );

  anchor.append(
    el(
      'div',
      { class: 'menu-panel', attrs: { id: PANEL_ID } },
      el(
        'div',
        { class: 'menu-shortcuts' },
        shortcut('Todas', []),
        shortcut('Nenhuma', excludeAllBut(names, [])),
      ),
      list,
      el(
        'div',
        { class: 'menu-foot' },
        shortcut('Restaurar padrão', DEFAULT_FILTERS.excludedChurches),
      ),
    ),
  );
  // The list is attached once the render that called this has finished.
  queueMicrotask(() => {
    list.scrollTop = listScroll;
  });

  return field;
};
