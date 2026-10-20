import {
  checkinMilestones,
  checkinSeries,
  ticketSummary,
} from '../core/metrics.ts';
import {
  axisTip,
  categoryAxis,
  chartCard,
  legend,
  roleBars,
  slotHeading,
  slotLabels,
  tooltip,
  valueAxis,
} from './charts.ts';
import { el } from './dom.ts';
import { fmtInt, fmtPercent, fmtSlot, fmtTime } from './format.ts';
import { state, update } from './state.ts';
import { card, kpi, note, segmented, table } from './ui.ts';

import type { Ctx } from './ctx.ts';

/** Slot lengths on offer. */
export const SLOT_OPTIONS = [
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '60 min' },
] as const;

/** Segmented control for the slot length, shared by the time tabs. */
export const slotToggle = (): HTMLElement =>
  segmented('Intervalo', SLOT_OPTIONS, state.slot, (slot) => {
    update({ slot });
  });

const ROLE_NAMES = {
  participant: 'Participantes',
  volunteer: 'Voluntários',
} as const;

/** The "Check-in" tab. */
export const checkin = (ctx: Ctx): HTMLElement => {
  const { rows, roles } = ctx;
  const minutes = state.slot;
  const series = checkinSeries(rows, minutes);
  const marks = checkinMilestones(rows, minutes);
  const tickets = ticketSummary(rows);

  const slots = chartCard({
    id: 'checkin-slots',
    title: 'Check-ins por intervalo',
    span: 12,
    height: 260,
    table: {
      caption: `Check-ins a cada ${String(minutes)} minutos`,
      head: ['Intervalo', ...roles.map((r) => ROLE_NAMES[r]), 'Total'],
      rows: series.map((s) => [
        fmtSlot(s.start, minutes),
        ...roles.map((r) => fmtInt(s[r])),
        fmtInt(s.total),
      ]),
    },
    option: (p) => ({
      tooltip: tooltip(p, {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: p.borderStrong } },
        formatter: axisTip(slotHeading(series, minutes)),
      }),
      legend: legend(p, roles.length === 2),
      grid: {
        left: 8,
        right: 12,
        top: 12,
        bottom: roles.length === 2 ? 32 : 8,
        containLabel: true,
      },
      xAxis: categoryAxis(p, slotLabels(series)),
      yAxis: valueAxis(p),
      series: roleBars(series, roles, p),
    }),
  });

  const cumulative = chartCard({
    id: 'checkin-cumulative',
    title: 'Total acumulado de check-ins',
    span: 12,
    height: 220,
    table: {
      caption: 'Total acumulado de check-ins',
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

  const milestones = el(
    'div',
    { class: 'kpis' },
    kpi(
      'Pico',
      marks.peak ? fmtSlot(marks.peak.start, minutes) : '—',
      marks.peak ? `${fmtInt(marks.peak.count)} check-ins` : '',
    ),
    kpi('50% presentes às', fmtTime(marks.half), 'dos check-ins finais'),
    kpi('90% presentes às', fmtTime(marks.ninety), 'dos check-ins finais'),
  );

  const parts: HTMLElement[] = [
    el('div', { class: 'toolbar' }, slotToggle()),
    milestones,
    el('div', { class: 'grid' }, slots, cumulative),
  ];

  if (ctx.roles.includes('participant') && tickets.preSale && tickets.walkIn) {
    const line = (
      name: string,
      s: {
        tickets: number;
        checkedIn: number;
        absent: number;
        noShowRate: number | null;
      },
    ): string[] => [
      name,
      fmtInt(s.tickets),
      fmtInt(s.checkedIn),
      fmtInt(s.absent),
      fmtPercent(s.noShowRate),
    ];

    parts.push(
      el(
        'div',
        { class: 'grid' },
        card('Quebra por tipo de ingresso', 12, [
          table(
            'Quebra por tipo de ingresso',
            ['Tipo', 'Ingressos', 'Presentes', 'Ausentes', '% quebra'],
            [
              line('Antecipado', tickets.preSale),
              line('No dia', tickets.walkIn),
              line('Total', tickets),
            ],
          ),
        ]),
      ),
    );
  }
  if (tickets.archived > 0) {
    parts.push(
      note(
        tickets.archived === 1
          ? 'A inscrição arquivada não é contabilizada.'
          : `As ${fmtInt(tickets.archived)} inscrições arquivadas não são contabilizadas.`,
      ),
    );
  }

  return el('div', { class: 'stack' }, ...parts);
};
