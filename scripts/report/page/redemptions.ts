import { ITEM_LABELS } from '../core/checkin.ts';
import {
  optionBreakdown,
  redeemedItems,
  redemptionSeries,
} from '../core/metrics.ts';
import {
  axisTip,
  barStyle,
  categoryAxis,
  chartCard,
  legend,
  roleBars,
  slotHeading,
  slotLabels,
  tooltip,
  valueAxis,
} from './charts.ts';
import { slotToggle } from './checkin.ts';
import { el } from './dom.ts';
import { fmtInt, fmtSlot } from './format.ts';
import { state, update } from './state.ts';
import { itemCard, select } from './ui.ts';

import type { Ctx } from './ctx.ts';
import type { Attendee, ItemKey } from '../core/checkin.ts';

const ROLE_NAMES = {
  participant: 'Participantes',
  volunteer: 'Voluntários',
} as const;

/**
 * Picks the item the redemption views show: the saved choice when it has
 * redemptions in `rows`, else the first redeemed item.
 *
 * @param rows - The filtered attendees.
 */
export const chosenItem = (rows: readonly Attendee[]): ItemKey => {
  const items = redeemedItems(rows).map((r) => r.item);

  return state.item && items.includes(state.item)
    ? state.item
    : (items[0] ?? 'meal');
};

/** The "Retiradas" tab. */
export const redemptions = (ctx: Ctx): HTMLElement => {
  const { rows, palette } = ctx;
  const summary = redeemedItems(rows);

  if (summary.length === 0) {
    return el(
      'p',
      { class: 'note' },
      'Nenhum item com direito a retirada nos dados filtrados.',
    );
  }
  const items = [...new Set(summary.map((r) => r.item))];
  const item = chosenItem(rows);
  const minutes = state.slot;
  const series = redemptionSeries(rows, item, minutes);
  const options = optionBreakdown(rows, item);

  const cards = summary.map((r) =>
    itemCard(r, ROLE_NAMES[r.role].replace(/s$/, ''), palette[r.role]),
  );

  const chart = chartCard({
    id: 'redemption-slots',
    title: `Retiradas por intervalo · ${ITEM_LABELS[item]}`,
    span: 12,
    height: 240,
    table: {
      caption: `Retiradas de ${ITEM_LABELS[item]} a cada ${String(minutes)} minutos`,
      head: ['Intervalo', ...ctx.roles.map((r) => ROLE_NAMES[r]), 'Total'],
      rows: series.map((s) => [
        fmtSlot(s.start, minutes),
        ...ctx.roles.map((r) => fmtInt(s[r])),
        fmtInt(s.total),
      ]),
    },
    option: (p) => ({
      tooltip: tooltip(p, {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: p.borderStrong } },
        formatter: axisTip(slotHeading(series, minutes)),
      }),
      legend: legend(p, ctx.roles.length === 2),
      grid: {
        left: 8,
        right: 12,
        top: 12,
        bottom: ctx.roles.length === 2 ? 32 : 8,
        containLabel: true,
      },
      xAxis: categoryAxis(p, slotLabels(series)),
      yAxis: valueAxis(p),
      series: roleBars(series, ctx.roles, p),
    }),
  });

  const cumulative = chartCard({
    id: 'redemption-cumulative',
    title: `Total acumulado de retiradas · ${ITEM_LABELS[item]}`,
    span: 12,
    height: 220,
    table: {
      caption: `Total acumulado de retiradas de ${ITEM_LABELS[item]}`,
      head: ['Intervalo', 'Acumulado'],
      rows: series.map((s) => [
        fmtSlot(s.start, minutes),
        fmtInt(s.cumulative),
      ]),
    },
    option: (p) => ({
      tooltip: tooltip(p, {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: p.borderStrong } },
        formatter: axisTip(slotHeading(series, minutes)),
      }),
      grid: { left: 8, right: 12, top: 12, bottom: 8, containLabel: true },
      xAxis: categoryAxis(p, slotLabels(series), { boundaryGap: false }),
      yAxis: valueAxis(p),
      series: [
        {
          type: 'line',
          name: 'Acumulado',
          color: p.accent,
          showSymbol: false,
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.12 },
          data: series.map((s) => s.cumulative),
        },
      ],
    }),
  });

  const names = options.map((o) => o.option);
  const optionsChart = chartCard({
    id: 'redemption-options',
    title: `Opções pedidas × retiradas · ${ITEM_LABELS[item]}`,
    span: 12,
    height: Math.max(140, options.length * 44 + 56),
    table: {
      caption: `Opções de ${ITEM_LABELS[item]}`,
      head: ['Opção', 'Pedidas', 'Retiradas'],
      rows: options.map((o) => [
        o.option,
        fmtInt(o.ordered),
        fmtInt(o.redeemed),
      ]),
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
      yAxis: categoryAxis(p, names, {
        inverse: true,
        axisLabel: {
          color: p.muted,
          fontSize: 11,
          width: 120,
          overflow: 'truncate',
        },
      }),
      series: [
        {
          type: 'bar',
          name: 'Pedidas',
          color: p.borderStrong,
          ...barStyle(p, true),
          data: options.map((o) => o.ordered),
        },
        {
          type: 'bar',
          name: 'Retiradas',
          color: p.accent,
          ...barStyle(p, true),
          data: options.map((o) => o.redeemed),
        },
      ],
    }),
  });

  return el(
    'div',
    { class: 'stack' },
    el('div', { class: 'item-grid' }, ...cards),
    el(
      'div',
      { class: 'toolbar' },
      select(
        'Item',
        items.map((i) => ({ value: i, label: ITEM_LABELS[i] })),
        item,
        (value) => {
          update({ item: value as ItemKey });
        },
      ),
      slotToggle(),
    ),
    el('div', { class: 'grid' }, chart, cumulative, optionsChart),
  );
};
