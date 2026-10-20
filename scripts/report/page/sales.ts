import { salesByBucket, salesEventDate } from '../core/sales.ts';
import {
  barStyle,
  categoryAxis,
  chartCard,
  tooltip,
  valueAxis,
} from './charts.ts';
import { el, escapeHtml } from './dom.ts';
import { DASH, fmtInt, fmtPercent, ratio } from './format.ts';
import { kpi, note } from './ui.ts';

import type { Attendee } from '../core/checkin.ts';
import type { NoSaleDateRow, SaleRow } from '../core/sales.ts';
import type { Ctx } from './ctx.ts';
import type { Palette } from './theme.ts';

// The package root's typings use `export =`, which NodeNext rejects in ESM;
// the dist typings are the same declarations.
import type * as Echarts from 'echarts/types/dist/echarts';

type EChartsOption = Echarts.EChartsOption;

/** A bar of the sales chart: a period, or the tickets without a date. */
export type SalesRow = SaleRow | NoSaleDateRow;

/** Headline figures of the sales rows. */
export interface SalesSummary {
  /** Tickets with a sale date. */
  dated: number;
  /** Tickets sold in the last seven days and on the event day. */
  lastWeek: number;
  /** Tickets sold on the event day. */
  onDay: number;
}

/** Whether a period is the last week before the event or the event day. */
const isLastWeek = (row: SalesRow): boolean =>
  row.id === 'week-0' || row.id === 'event';

/** The bar group a row belongs to, to separate months, weeks and the day. */
const groupOf = (row: SalesRow): string => row.id.split('-')[0] ?? row.id;

/**
 * Tells whether any participant ticket carries a sale date.
 *
 * @param attendees - Every row of the export.
 */
export const hasSales = (attendees: readonly Attendee[]): boolean =>
  attendees.some(
    (a) => a.role === 'participant' && !a.archived && a.saleDate !== null,
  );

/**
 * Counts tickets per sale period under the active filters, anchored on the
 * event day of the unfiltered data so the bars do not move with the filters.
 *
 * @param ctx - The context the tabs use.
 * @returns Rows oldest first; `[]` when no ticket in view has a date.
 */
export const salesRows = (ctx: Ctx): SalesRow[] => {
  const eventDate = salesEventDate(ctx.data.attendees);

  return eventDate === null ? [] : salesByBucket(ctx.rows, eventDate);
};

/**
 * Sums the headline figures of the sales rows.
 *
 * @param rows - Rows from {@link salesRows}.
 */
export const summarise = (rows: readonly SalesRow[]): SalesSummary => {
  const dated = rows.filter((r) => r.id !== 'none');
  const sum = (list: readonly SalesRow[]): number =>
    list.reduce((total, r) => total + r.tickets, 0);

  return {
    dated: sum(dated),
    lastWeek: sum(dated.filter(isLastWeek)),
    onDay: sum(dated.filter((r) => r.id === 'event')),
  };
};

const dayMonth = (iso: string): string => `${iso.slice(8)}/${iso.slice(5, 7)}`;

const fullDate = (iso: string | null): string =>
  iso === null ? DASH : `${dayMonth(iso)}/${iso.slice(0, 4)}`;

const plural = (n: number): string =>
  `${fmtInt(n)} ${n === 1 ? 'ingresso' : 'ingressos'}`;

/** The dates a bar covers, e.g. `17/08 – 18/09`; `null` for undated tickets. */
const rangeOf = (row: SalesRow): string | null => {
  if (row.id === 'none') return null;
  const { from, to } = row as SaleRow;

  if (to === null) return null;
  if (from === null) return `até ${dayMonth(to)}`;

  return from === to ? dayMonth(from) : `${dayMonth(from)} – ${dayMonth(to)}`;
};

/**
 * Puts a label's last word on its own, smaller line in ECharts rich text, so
 * "2–3 semanas" fits a narrow slot as "2–3" over "semanas".
 */
const twoLineLabel = (label: string): string => {
  const cut = label.lastIndexOf(' ');

  if (label.trim() === '') return '';

  return cut < 0
    ? `{n|${label}}`
    : `{n|${label.slice(0, cut)}}\n{u|${label.slice(cut + 1)}}`;
};

/**
 * Lays the rows out as bar slots, leaving an empty slot where the group
 * changes (months, weeks, days, event day, undated) as a gap between groups.
 */
const withGaps = (rows: readonly SalesRow[]): (SalesRow | null)[] =>
  rows.flatMap((r, i) => {
    const previous = rows[i - 1];

    return previous && groupOf(previous) !== groupOf(r) ? [null, r] : [r];
  });

/** Style of the chart, in pixels, that differs between the page and a slide. */
export interface SalesChartSizes {
  axisFont: number;
  labelFont: number;
  barMaxWidth: number;
  /** Rotation of the x labels; 0 draws them flat. */
  rotate: number;
  /** Draws labels on two lines instead of rotating them. */
  breakLabels: boolean;
  grid: { left: number; right: number; top: number; bottom: number };
}

/**
 * Builds the bar chart option shared by the tab and the slide.
 *
 * @param rows - Rows from {@link salesRows}.
 * @param p - The resolved palette.
 * @param sizes - Font and spacing choices.
 */
export const salesOption = (
  rows: readonly SalesRow[],
  p: Palette,
  sizes: SalesChartSizes,
): EChartsOption => {
  const slots = withGaps(rows);
  // Gap slots need distinct names, or the axis merges them.
  const names = slots.map((r, i) => (r === null ? ' '.repeat(i + 1) : r.label));

  return {
    tooltip: tooltip(p, {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (raw: unknown): string => {
        const first = (Array.isArray(raw) ? raw : [raw])[0] as
          { dataIndex?: number } | undefined;
        const row = slots[first?.dataIndex ?? -1];

        if (!row) return '';
        const range = rangeOf(row);

        return `<strong>${escapeHtml(row.label)}</strong><br/>${escapeHtml(
          range === null ? '' : `${range}: `,
        )}${escapeHtml(plural(row.tickets))}`;
      },
    }),
    grid: { ...sizes.grid, containLabel: true },
    xAxis: categoryAxis(p, names, {
      axisLabel: {
        color: p.muted,
        fontSize: sizes.axisFont,
        interval: 0,
        rotate: sizes.rotate,
        hideOverlap: !sizes.breakLabels,
        ...(sizes.breakLabels && {
          formatter: twoLineLabel,
          rich: {
            n: { fontSize: sizes.axisFont, color: p.muted },
            u: { fontSize: sizes.axisFont - 4, color: p.muted },
          },
        }),
      },
    }),
    yAxis: valueAxis(p, {
      minInterval: 1,
      axisLabel: { color: p.muted, fontSize: sizes.axisFont },
    }),
    series: [
      {
        type: 'bar',
        name: 'Ingressos',
        color: p.participant,
        ...barStyle(p),
        barMaxWidth: sizes.barMaxWidth,
        label: {
          show: true,
          position: 'top',
          color: p.text,
          fontSize: sizes.labelFont,
          formatter: (q: { value?: unknown }): string =>
            q.value === 0 ? '' : fmtInt(Number(q.value)),
        },
        labelLayout: { hideOverlap: true },
        data: slots.map((r) =>
          r === null
            ? '-'
            : r.id === 'none'
              ? { value: r.tickets, itemStyle: { color: p.borderStrong } }
              : r.tickets,
        ),
      },
    ],
  };
};

/** The "Vendas" tab: when participant tickets were sold. */
export const sales = (ctx: Ctx): HTMLElement => {
  const rows = salesRows(ctx);
  const total = rows.reduce((sum, r) => sum + r.tickets, 0);
  const { dated, lastWeek, onDay } = summarise(rows);

  if (rows.length === 0) {
    return el(
      'div',
      { class: 'stack' },
      note('Nenhum ingresso com data de venda nos filtros atuais.'),
    );
  }
  const share = (n: number): string => fmtPercent(ratio(n, dated));

  return el(
    'div',
    { class: 'stack' },
    el(
      'div',
      { class: 'kpis' },
      kpi('Ingressos com data de venda', fmtInt(dated), 'participantes'),
      kpi(
        'Vendidos na última semana',
        fmtInt(lastWeek),
        `${share(lastWeek)} dos ingressos com data`,
      ),
      kpi(
        'Vendidos no dia',
        fmtInt(onDay),
        `${share(onDay)} dos ingressos com data`,
      ),
    ),
    el(
      'div',
      { class: 'grid' },
      chartCard({
        id: 'sales',
        title: 'Ingressos por período de venda',
        span: 12,
        height: 340,
        table: {
          caption: 'Ingressos de participantes por período de venda',
          head: ['Período', 'De', 'Até', 'Ingressos', '% do total'],
          rows: rows.map((r) => [
            r.label,
            fullDate('from' in r ? r.from : null),
            fullDate('to' in r ? r.to : null),
            fmtInt(r.tickets),
            fmtPercent(ratio(r.tickets, total)),
          ]),
        },
        option: (p) =>
          salesOption(rows, p, {
            axisFont: 11,
            labelFont: 11,
            barMaxWidth: 28,
            // Phones have under 20px per bar: stand the labels up.
            rotate: matchMedia('(max-width: 600px)').matches ? 90 : 45,
            breakLabels: false,
            grid: { left: 8, right: 16, top: 24, bottom: 8 },
          }),
      }),
    ),
  );
};
