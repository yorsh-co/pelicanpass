import { el, escapeHtml } from './dom.ts';
import { fmtInt, fmtSlot, fmtTime } from './format.ts';
import { prefersReducedMotion } from './theme.ts';
import { card, table } from './ui.ts';
import { state, update } from './state.ts';

// The package root's typings use `export =`, which NodeNext rejects in ESM;
// the dist typings are the same declarations.
import type * as Echarts from 'echarts/types/dist/echarts';

type ECharts = Echarts.ECharts;
type EChartsOption = Echarts.EChartsOption;

import type { Palette } from './theme.ts';
import type { Slot } from '../core/metrics.ts';
import type { Child } from './dom.ts';

declare const echarts: typeof Echarts;

/** The same numbers as a chart, for the table view. */
export interface TableData {
  caption: string;
  head: string[];
  rows: string[][];
}

/** Description of a chart card. */
export interface ChartSpec {
  /** Stable key for the table toggle. */
  id: string;
  title: string;
  span: number;
  height: number;
  option: (palette: Palette) => EChartsOption;
  table: TableData;
  /** Called with the index of a clicked bar. */
  onClick?: (index: number) => void;
  extra?: Child[];
}

interface Mount {
  host: HTMLElement;
  option: (palette: Palette) => EChartsOption;
  onClick?: ((index: number) => void) | undefined;
}

let pending: Mount[] = [];
let live: { chart: ECharts; observer: ResizeObserver }[] = [];

/** Builds a card whose chart can be swapped for its table. */
export const chartCard = (spec: ChartSpec): HTMLElement => {
  const showTable = state.tables.has(spec.id);
  const toggle = el(
    'button',
    {
      class: 'link-button',
      attrs: { type: 'button', 'aria-pressed': String(showTable) },
      on: {
        click: () => {
          const tables = new Set(state.tables);

          if (showTable) tables.delete(spec.id);
          else tables.add(spec.id);
          update({ tables });
        },
      },
    },
    showTable ? 'Ver gráfico' : 'Ver tabela',
  );
  let body: HTMLElement;

  if (showTable) {
    body = table(spec.table.caption, spec.table.head, spec.table.rows);
  } else {
    const host = el('div', {
      class: 'chart',
      attrs: {
        role: 'img',
        'aria-label': spec.title,
        style: `height:${String(spec.height)}px`,
      },
    });

    pending.push({ host, option: spec.option, onClick: spec.onClick });
    body = host;
  }

  return card(spec.title, spec.span, [...(spec.extra ?? []), body], [toggle]);
};

/** Frees every chart of the previous render. */
export const disposeCharts = (): void => {
  for (const { chart, observer } of live) {
    observer.disconnect();
    chart.dispose();
  }
  live = [];
  pending = [];
};

/**
 * Creates a bare chart host, drawn by the next {@link mountCharts}. Callers
 * size it with CSS.
 *
 * @param label - Accessible name of the chart.
 * @param option - Builds the ECharts option from the resolved palette.
 */
export const chartBox = (
  label: string,
  option: (palette: Palette) => EChartsOption,
): HTMLElement => {
  const host = el('div', {
    class: 'chart',
    attrs: { role: 'img', 'aria-label': label },
  });

  pending.push({ host, option });

  return host;
};

/** Initialises the charts of the hosts just attached to the document. */
export const mountCharts = (palette: Palette): void => {
  for (const { host, option, onClick } of pending) {
    const chart = echarts.init(host, null, { renderer: 'svg' });

    chart.setOption({
      animation: !prefersReducedMotion(),
      textStyle: {
        fontFamily: "'Libre Franklin', system-ui, sans-serif",
        color: palette.muted,
      },
      ...option(palette),
    });
    if (onClick) {
      chart.on('click', (params) => {
        if (typeof params.dataIndex === 'number') onClick(params.dataIndex);
      });
    }
    const observer = new ResizeObserver(() => {
      chart.resize();
    });

    observer.observe(host);
    live.push({ chart, observer });
  }
  pending = [];
};

/** Tooltip styling shared by every chart. */
export const tooltip = (
  palette: Palette,
  extra: Record<string, unknown> = {},
): NonNullable<EChartsOption['tooltip']> => ({
  confine: true,
  backgroundColor: palette.surface,
  borderColor: palette.border,
  borderWidth: 1,
  textStyle: { color: palette.text, fontSize: 12 },
  extraCssText: 'box-shadow:0 2px 8px rgb(0 0 0 / 12%);',
  ...extra,
});

/** Axis line and label styles. */
export const categoryAxis = (
  palette: Palette,
  data: string[],
  extra: Record<string, unknown> = {},
) => ({
  type: 'category' as const,
  data,
  axisLine: { lineStyle: { color: palette.border } },
  axisTick: { show: false },
  axisLabel: { color: palette.muted, fontSize: 11 },
  ...extra,
});

export const valueAxis = (
  palette: Palette,
  extra: Record<string, unknown> = {},
) => ({
  type: 'value' as const,
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: { color: palette.muted, fontSize: 11 },
  splitLine: {
    lineStyle: { color: palette.border, type: 'solid' as const, width: 1 },
  },
  ...extra,
});

/** Thin, rounded bar with a gap to its neighbours. */
export const barStyle = (palette: Palette, horizontal = false) => ({
  barMaxWidth: 14,
  itemStyle: {
    borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
    borderColor: palette.surface,
    borderWidth: 1,
  },
});

interface TipParam {
  marker?: string;
  seriesName?: string;
  value?: unknown;
  axisValueLabel?: string;
}

/**
 * Formats an axis tooltip: a heading and one line per series.
 *
 * @param heading - Replaces the axis label when given.
 * @param format - Formats a value.
 */
export const axisTip =
  (
    heading?: (index: number) => string,
    format: (value: unknown) => string = (v) => fmtInt(Number(v)),
  ) =>
  (raw: unknown): string => {
    const params = (Array.isArray(raw) ? raw : [raw]) as (TipParam & {
      dataIndex?: number;
    })[];
    const first = params[0];
    const title =
      heading && first?.dataIndex !== undefined
        ? heading(first.dataIndex)
        : (first?.axisValueLabel ?? '');

    return [
      `<strong>${escapeHtml(title)}</strong>`,
      ...params.map(
        (p) =>
          `${p.marker ?? ''}${escapeHtml(p.seriesName ?? '')}: ${escapeHtml(format(p.value))}`,
      ),
    ].join('<br/>');
  };

/** The role series for stacked slot bars. */
export const roleBars = (
  slots: readonly Slot[],
  roles: readonly ('participant' | 'volunteer')[],
  palette: Palette,
) =>
  roles.map((role) => ({
    type: 'bar' as const,
    name: role === 'participant' ? 'Participantes' : 'Voluntários',
    stack: 'slot',
    color: palette[role],
    ...barStyle(palette),
    data: slots.map((s) => s[role]),
  }));

/** Slot x-axis labels. */
export const slotLabels = (slots: readonly Slot[]): string[] =>
  slots.map((s) => fmtTime(s.start));

/** Heading for slot tooltips. */
export const slotHeading =
  (slots: readonly Slot[], minutes: number) =>
  (index: number): string =>
    fmtSlot(slots[index]?.start ?? 0, minutes);

/** A bottom legend, shown only when asked: charts with one series need none. */
export const legend = (palette: Palette, show: boolean) => ({
  show,
  bottom: 0,
  textStyle: { color: palette.muted },
});
