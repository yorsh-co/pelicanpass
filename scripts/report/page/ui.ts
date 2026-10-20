import { ITEM_LABELS } from '../core/checkin.ts';
import { el } from './dom.ts';
import { DASH, fmtDuration, fmtInt, fmtPercent, fmtTime } from './format.ts';

import type { ItemRow } from '../core/metrics.ts';
import type { Child } from './dom.ts';
import type { Theme } from './theme.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Feather-style outlines: a moon to go dark, a sun to go light. */
const ICONS: Readonly<Record<Theme, readonly string[]>> = {
  light: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'],
  dark: [
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    'M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  ],
};

/**
 * The light/dark toggle. Like the app's, its icon and label name the theme a
 * click switches to, not the one in effect.
 *
 * @param theme - The theme in effect.
 * @param onToggle - Called on click.
 */
export const themeToggle = (
  theme: Theme,
  onToggle: () => void,
): HTMLElement => {
  const svg = document.createElementNS(SVG_NS, 'svg');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[theme]) {
    const path = document.createElementNS(SVG_NS, 'path');

    path.setAttribute('d', d);
    svg.append(path);
  }

  return el(
    'button',
    {
      class: 'theme-toggle',
      attrs: {
        type: 'button',
        'aria-label':
          theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro',
        'data-focus': 'theme-toggle',
      },
      on: { click: onToggle },
    },
    svg,
  );
};

/** A grid card with an uppercase title. */
export const card = (
  title: string,
  span: number,
  body: Child[],
  actions: Child[] = [],
): HTMLElement =>
  el(
    'section',
    { class: 'card', attrs: { style: `--span:${String(span)}` } },
    el(
      'header',
      { class: 'card-head' },
      el('h2', { class: 'card-title' }, title),
      ...actions,
    ),
    ...body,
  );

/** A KPI tile. */
export const kpi = (label: string, value: string, sub: string): HTMLElement =>
  el(
    'div',
    { class: 'kpi' },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value' }, value),
    el('div', { class: 'kpi-sub' }, sub),
  );

/** A segmented control of mutually exclusive options. */
export const segmented = <T extends string | number>(
  label: string,
  options: readonly { value: T; label: string }[],
  current: T,
  onChange: (value: T) => void,
): HTMLElement =>
  el(
    'div',
    { class: 'segmented', attrs: { role: 'group', 'aria-label': label } },
    ...options.map((option) =>
      el(
        'button',
        {
          attrs: {
            type: 'button',
            'aria-pressed': String(option.value === current),
            'data-focus': `${label}:${String(option.value)}`,
          },
          on: {
            click: () => {
              onChange(option.value);
            },
          },
        },
        option.label,
      ),
    ),
  );

/** A labelled group of independent toggle buttons, none pressed meaning all. */
export const toggleGroup = <T extends string>(
  label: string,
  hint: string,
  options: readonly { value: T; label: string; title?: string }[],
  selected: readonly T[],
  onToggle: (value: T) => void,
): HTMLElement =>
  el(
    'div',
    { class: 'field field-chips' },
    el('span', {}, label),
    el(
      'div',
      {
        class: 'segmented',
        attrs: { role: 'group', 'aria-label': label, title: hint },
      },
      ...options.map((option) =>
        el(
          'button',
          {
            attrs: {
              type: 'button',
              'aria-pressed': String(selected.includes(option.value)),
              'data-focus': `${label}:${option.value}`,
              ...(option.title === undefined
                ? {}
                : { title: option.title, 'aria-label': option.title }),
            },
            on: {
              click: () => {
                onToggle(option.value);
              },
            },
          },
          option.label,
        ),
      ),
    ),
  );

/** A labelled select. */
export const select = (
  label: string,
  options: readonly { value: string; label: string }[],
  current: string,
  onChange: (value: string) => void,
): HTMLElement => {
  const control = el(
    'select',
    {
      attrs: { 'data-focus': `select:${label}` },
      on: {
        change: () => {
          onChange(control.value);
        },
      },
    },
    ...options.map((option) => {
      const node = el(
        'option',
        { attrs: { value: option.value } },
        option.label,
      );

      node.selected = option.value === current;

      return node;
    }),
  );

  return el('label', { class: 'field' }, el('span', {}, label), control);
};

/** A small status line. */
export const note = (text: string): HTMLElement =>
  el('p', { class: 'note' }, text);

/** A thin horizontal progress bar. */
export const bar = (share: number | null, color?: string): HTMLElement =>
  el(
    'div',
    { class: 'bar', attrs: { role: 'presentation' } },
    el('div', {
      class: 'bar-fill',
      attrs: {
        style: `width:${String(Math.round((share ?? 0) * 1000) / 10)}%${color === undefined ? '' : `;background:${color}`}`,
      },
    }),
  );

/**
 * A redemption card that leads with how long redemption took. A single
 * redemption has no window, so its duration is a dash.
 *
 * @param row - Redemption of one item by one role.
 * @param role - Role name shown on the chip.
 * @param color - Role colour.
 */
export const itemCard = (
  row: ItemRow,
  role: string,
  color: string,
): HTMLElement => {
  const range =
    row.first === row.last
      ? fmtTime(row.first)
      : `${fmtTime(row.first)}–${fmtTime(row.last)}`;

  return el(
    'article',
    { class: 'item-card' },
    el(
      'div',
      { class: 'item-head' },
      el('h3', {}, ITEM_LABELS[row.item]),
      el('span', { class: 'chip', attrs: { style: `--chip:${color}` } }, role),
    ),
    el('div', { class: 'item-meta' }, 'Tempo de retirada'),
    el(
      'div',
      { class: 'item-duration' },
      row.windowMs ? fmtDuration(row.windowMs) : DASH,
    ),
    el('div', { class: 'item-meta' }, range),
    el(
      'div',
      { class: 'item-meta item-meta--strong' },
      `${fmtInt(row.redeemed)} de ${fmtInt(row.entitled)} retirados (${fmtPercent(row.rate)})`,
    ),
    bar(row.rate, color),
  );
};

/** A plain table inside a scroll wrapper. */
export const table = (
  caption: string,
  head: readonly string[],
  rows: readonly (readonly string[])[],
  titles: readonly string[] = [],
  wrapHeaders = false,
): HTMLElement =>
  el(
    'div',
    { class: wrapHeaders ? 'table-wrap wrap-headers' : 'table-wrap' },
    el(
      'table',
      {},
      el('caption', { class: 'sr-only' }, caption),
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          ...head.map((text, i) =>
            el(
              'th',
              {
                attrs: {
                  scope: 'col',
                  ...(titles[i] === undefined ? {} : { title: titles[i] }),
                },
              },
              text,
            ),
          ),
        ),
      ),
      el(
        'tbody',
        {},
        ...rows.map((row) =>
          el(
            'tr',
            {},
            ...row.map((cell, i) =>
              el(
                i === 0 ? 'th' : 'td',
                i === 0 ? { attrs: { scope: 'row' } } : {},
                cell,
              ),
            ),
          ),
        ),
      ),
    ),
  );
