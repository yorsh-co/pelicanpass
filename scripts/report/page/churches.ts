import {
  applyFilters,
  toggleChurch as toggleExcluded,
} from '../core/filter.ts';
import { byChurch, churchKey, hostChurchSplit } from '../core/metrics.ts';
import {
  axisTip,
  barStyle,
  categoryAxis,
  chartCard,
  tooltip,
  valueAxis,
} from './charts.ts';
import { el } from './dom.ts';
import { fmtInt, fmtPercent } from './format.ts';
import { state, update } from './state.ts';
import { card, kpi, note } from './ui.ts';

import type {
  AttendanceSplit,
  ChurchRow,
  HostChurchSplit,
} from '../core/metrics.ts';
import type { Ctx } from './ctx.ts';
import type { ChurchSortKey } from './state.ts';

/** Excludes a church from the filter, or includes it again. */
export const toggleChurch = (church: string): void => {
  update({
    filters: {
      ...state.filters,
      excludedChurches: toggleExcluded(state.filters.excludedChurches, church),
    },
  });
};

const splitTile = (label: string, group: AttendanceSplit): HTMLElement =>
  kpi(
    label,
    fmtInt(group.tickets),
    `${fmtInt(group.checkedIn)} presentes · ${fmtPercent(group.noShowRate)} de quebra`,
  );

/**
 * Tiles comparing the host church with all other churches.
 *
 * @param split - The comparison to show.
 * @param hostChurch - Name labelling the host church's tile.
 */
export const hostTiles = (
  split: HostChurchSplit,
  hostChurch: string,
): HTMLElement[] => [
  splitTile(hostChurch, split.host),
  splitTile('Outras igrejas', split.others),
];

/** Says who the host comparison leaves out; `null` when nobody. */
export const hostNote = (split: HostChurchSplit): string | null =>
  split.unknown > 0
    ? `${fmtInt(split.unknown)} participantes sem igreja informada não entram nesta comparação.`
    : null;

const COLUMNS: readonly { key: ChurchSortKey; label: string }[] = [
  { key: 'church', label: 'Igreja' },
  { key: 'tickets', label: 'Ingressos' },
  { key: 'checkedIn', label: 'Presentes' },
  { key: 'absent', label: 'Ausentes' },
  { key: 'noShowRate', label: '% quebra' },
];

const sorted = (rows: readonly ChurchRow[]): ChurchRow[] => {
  const { key, descending } = state.churchSort;
  const factor = descending ? -1 : 1;

  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];

    if (typeof x === 'string' && typeof y === 'string')
      return factor * x.localeCompare(y, 'pt-BR');

    return (
      factor * (((x as number | null) ?? -1) - ((y as number | null) ?? -1))
    );
  });
};

/** The "Igrejas" tab. Other churches stay visible so the filter can change. */
export const churches = (ctx: Ctx): HTMLElement => {
  const unfiltered = applyFilters(ctx.data.attendees, {
    ...ctx.filters,
    excludedChurches: [],
  });
  const rows = byChurch(unfiltered);
  const split = hostChurchSplit(
    applyFilters(ctx.data.attendees, ctx.filters),
    ctx.hostChurch,
  );
  const splitNote = split && hostNote(split);
  const excluded = new Set(ctx.filters.excludedChurches.map(churchKey));
  const isExcluded = (church: string): boolean =>
    excluded.has(churchKey(church));
  const opacity = (church: string): number => (isExcluded(church) ? 0.3 : 1);

  const chart = chartCard({
    id: 'churches',
    title: 'Presença por igreja',
    span: 12,
    height: Math.max(160, rows.length * 34 + 64),
    table: {
      caption: 'Presença por igreja',
      head: ['Igreja', 'Presentes', 'Ausentes'],
      rows: rows.map((r) => [r.church, fmtInt(r.checkedIn), fmtInt(r.absent)]),
    },
    onClick: (index) => {
      const row = rows[index];

      if (row) toggleChurch(row.church);
    },
    option: (p) => ({
      tooltip: tooltip(p, {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: axisTip(),
      }),
      legend: { bottom: 0, textStyle: { color: p.muted } },
      grid: { left: 8, right: 24, top: 8, bottom: 32, containLabel: true },
      xAxis: valueAxis(p),
      yAxis: categoryAxis(
        p,
        rows.map((r) => r.church),
        {
          inverse: true,
          axisLabel: {
            color: p.muted,
            fontSize: 11,
            width: 130,
            overflow: 'truncate',
          },
        },
      ),
      series: [
        {
          type: 'bar',
          name: 'Presentes',
          stack: 'church',
          ...barStyle(p, true),
          color: p.accent,
          data: rows.map((r) => ({
            value: r.checkedIn,
            itemStyle: { opacity: opacity(r.church) },
          })),
        },
        {
          type: 'bar',
          name: 'Ausentes',
          stack: 'church',
          ...barStyle(p, true),
          color: p.borderStrong,
          data: rows.map((r) => ({
            value: r.absent,
            itemStyle: { opacity: opacity(r.church) },
          })),
        },
      ],
    }),
  });

  const head = el(
    'tr',
    {},
    ...COLUMNS.map(({ key, label }) => {
      const active = state.churchSort.key === key;

      return el(
        'th',
        {
          attrs: {
            scope: 'col',
            'aria-sort': active
              ? state.churchSort.descending
                ? 'descending'
                : 'ascending'
              : 'none',
          },
        },
        el(
          'button',
          {
            class: 'sort',
            attrs: { type: 'button', 'data-focus': `sort:${key}` },
            on: {
              click: () => {
                update({
                  churchSort: {
                    key,
                    descending: active
                      ? !state.churchSort.descending
                      : key !== 'church',
                  },
                });
              },
            },
          },
          label,
          active ? (state.churchSort.descending ? ' ↓' : ' ↑') : '',
        ),
      );
    }),
  );

  const body = sorted(rows).map((r) =>
    el(
      'tr',
      { class: isExcluded(r.church) ? 'excluded' : 'selected' },
      el(
        'th',
        { attrs: { scope: 'row' } },
        el(
          'button',
          {
            class: 'link-button',
            attrs: {
              type: 'button',
              'aria-pressed': String(!isExcluded(r.church)),
            },
            on: {
              click: () => {
                toggleChurch(r.church);
              },
            },
          },
          r.church,
        ),
        isExcluded(r.church) ? el('span', { class: 'tag' }, 'excluída') : null,
      ),
      el('td', {}, fmtInt(r.tickets)),
      el('td', {}, fmtInt(r.checkedIn)),
      el('td', {}, fmtInt(r.absent)),
      el('td', {}, fmtPercent(r.noShowRate)),
    ),
  );

  return el(
    'div',
    { class: 'stack' },
    note('Clique em uma barra ou linha para incluir ou excluir uma igreja.'),
    split && ctx.hostChurch !== null
      ? el('div', { class: 'kpis' }, ...hostTiles(split, ctx.hostChurch))
      : null,
    splitNote ? note(splitNote) : null,
    el(
      'div',
      { class: 'grid' },
      chart,
      card('Igrejas', 12, [
        el(
          'div',
          { class: 'table-wrap' },
          el('table', {}, el('thead', {}, head), el('tbody', {}, ...body)),
        ),
      ]),
    ),
  );
};
