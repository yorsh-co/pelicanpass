import { UNKNOWN_AGE, toggleAge as toggleAgeChoice } from '../core/age.ts';
import { applyFilters } from '../core/filter.ts';
import { byAgeDetail } from '../core/metrics.ts';
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
import { card, note } from './ui.ts';

import type { AgeChoice } from '../core/age.ts';
import type { AgeDetailRow } from '../core/metrics.ts';
import type { Ctx } from './ctx.ts';

/** Adds the band to the age filter, or removes it when already selected. */
export const toggleAge = (band: AgeChoice): void => {
  const filters = { ...state.filters };

  filters.age = toggleAgeChoice(filters.age, band);
  update({ filters });
};

const COLUMNS = [
  'Faixa etária',
  'Ingressos',
  'Presentes',
  'Ausentes',
  '% quebra',
];

/** The filter value a row stands for. */
const choiceOf = (row: AgeDetailRow): AgeChoice => row.band ?? UNKNOWN_AGE;

/** The "Faixa etária" section of the profile tab, whole when an age is set. */
export const ages = (ctx: Ctx): HTMLElement | null => {
  const rows = byAgeDetail(
    applyFilters(ctx.data.attendees, { ...ctx.filters, age: [] }),
  );

  if (rows.length === 0) return null;
  const selected = ctx.filters.age;
  const lit = (r: AgeDetailRow): boolean =>
    selected.length === 0 || selected.includes(choiceOf(r));
  const bars = (key: 'checkedIn' | 'absent') =>
    rows.map((r) => ({
      value: r[key],
      itemStyle: { opacity: lit(r) ? 1 : 0.3 },
      label: {
        color: lit(r) ? ctx.palette.text : ctx.palette.muted,
      },
    }));

  const chart = chartCard({
    id: 'ages',
    title: 'Presença por faixa etária',
    span: 12,
    height: 320,
    table: {
      caption: 'Presença por faixa etária',
      head: ['Faixa etária', 'Presentes', 'Ausentes'],
      rows: rows.map((r) => [r.detail, fmtInt(r.checkedIn), fmtInt(r.absent)]),
    },
    onClick: (index) => {
      const row = rows[index];

      if (row) toggleAge(choiceOf(row));
    },
    option: (p) => ({
      tooltip: tooltip(p, {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: axisTip(),
      }),
      legend: { bottom: 0, textStyle: { color: p.muted } },
      grid: { left: 8, right: 8, top: 28, bottom: 32, containLabel: true },
      xAxis: categoryAxis(
        p,
        rows.map((r) => r.detail),
        {
          axisLabel: {
            color: p.muted,
            fontSize: 11,
            interval: 0,
            width: 40,
            formatter: (detail: string) =>
              detail === UNKNOWN_AGE ? 'S/ idade' : detail,
            overflow: 'break',
          },
        },
      ),
      yAxis: valueAxis(p, { minInterval: 1 }),
      series: [
        {
          type: 'bar',
          name: 'Presentes',
          stack: 'age',
          ...barStyle(p),
          barMaxWidth: 32,
          color: p.accent,
          data: bars('checkedIn'),
        },
        {
          type: 'bar',
          name: 'Ausentes',
          stack: 'age',
          ...barStyle(p),
          barMaxWidth: 32,
          color: p.borderStrong,
          label: {
            show: true,
            position: 'top',
            fontSize: 11,
            formatter: (q: { dataIndex: number }) => {
              const rate = rows[q.dataIndex]?.noShowRate ?? null;

              return rate === null ? '' : fmtPercent(rate);
            },
          },
          data: bars('absent'),
        },
      ],
    }),
  });

  const body = rows.map((r) =>
    el(
      'tr',
      { class: selected.includes(choiceOf(r)) ? 'selected' : '' },
      el(
        'th',
        { attrs: { scope: 'row' } },
        el(
          'button',
          {
            class: 'link-button',
            attrs: {
              type: 'button',
              'aria-pressed': String(selected.includes(choiceOf(r))),
            },
            on: {
              click: () => {
                toggleAge(choiceOf(r));
              },
            },
          },
          r.detail,
        ),
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
    note('Clique em uma barra ou linha para filtrar por idade.'),
    el(
      'div',
      { class: 'grid' },
      chart,
      card('Faixas etárias', 12, [
        el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            {},
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                ...COLUMNS.map((label) =>
                  el('th', { attrs: { scope: 'col' } }, label),
                ),
              ),
            ),
            el('tbody', {}, ...body),
          ),
        ),
      ]),
    ),
  );
};
