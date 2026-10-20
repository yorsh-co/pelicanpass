import { UNKNOWN_AGE } from '../../core/age.ts';
import { applyFilters } from '../../core/filter.ts';
import { topChurches } from '../../core/deck.ts';
import {
  byAgeDetail,
  byChurch,
  churchKey,
  checkinMilestones,
  checkinSeries,
  hostChurchSplit,
  redemptionSeries,
  ratingStats,
  responseRate,
  scoreBands,
  ticketSummary,
} from '../../core/metrics.ts';
import { ITEM_LABELS } from '../../core/checkin.ts';
import { groupRatings } from '../../core/rating-groups.ts';
import {
  barStyle,
  categoryAxis,
  roleBars,
  slotLabels,
  valueAxis,
} from '../charts.ts';
import { el } from '../dom.ts';
import {
  fmtDecimal,
  fmtInt,
  fmtPercent,
  fmtSlot,
  fmtTime,
  ratio,
} from '../format.ts';
import { hostNote, hostTiles } from '../churches.ts';
import { chosenItem } from '../redemptions.ts';
import { salesOption, salesRows, summarise } from '../sales.ts';
import { kpi } from '../ui.ts';
import {
  AXIS_FONT,
  compact,
  LABEL_FONT,
  participantSurvey,
  slideChart,
  surveyNote,
} from './shared.ts';

import type { AgeDetailRow, RatingStat } from '../../core/metrics.ts';
import type { GroupedRatings } from '../../core/rating-groups.ts';
import type { Ctx } from '../ctx.ts';
import type { Palette } from '../theme.ts';
import type { Slide } from './types.ts';

/** Check-in runs for about 90 minutes, so 5-minute points show its shape. */
const SLOT = 5;

const OVERALL = 'overall_rating';

/** Category labels of the age bands, which sit under every bar. */
const AGE_AXIS_FONT = 28;

/** Bucket labels run to two lines under 15 narrow bars. */
const SALES_AXIS_FONT = 22;

/** Check-ins of one role over time, with the arrival milestones beside it. */
export const checkinSlide = (ctx: Ctx): Slide => ({
  id: 'checkin',
  layout: 'content',
  eyebrow: 'Check-in',
  title: 'Check-ins por horário',
  note: null,
  render: () => {
    const { rows, roles } = ctx;
    const hasArrivals = (role: 'participant' | 'volunteer'): boolean =>
      roles.includes(role) &&
      rows.some((a) => a.role === role && a.checkedIn && a.checkinAt !== null);
    const role = hasArrivals('participant') ? 'participant' : 'volunteer';
    const own = rows.filter((a) => a.role === role);
    const series = checkinSeries(own, SLOT);
    const marks = checkinMilestones(own, SLOT);
    const volunteerTimes =
      role === 'participant' && roles.includes('volunteer')
        ? rows.flatMap((a) =>
            a.role === 'volunteer' && a.checkedIn && a.checkinAt !== null
              ? [a.checkinAt]
              : [],
          )
        : [];

    const chart = slideChart('Check-ins a cada 5 minutos', (p) => ({
      grid: { left: 8, right: 32, top: 24, bottom: 8, containLabel: true },
      xAxis: categoryAxis(p, slotLabels(series), {
        boundaryGap: false,
        axisLabel: { color: p.muted, fontSize: AXIS_FONT, hideOverlap: true },
      }),
      yAxis: valueAxis(p, {
        minInterval: 1,
        axisLabel: { color: p.muted, fontSize: AXIS_FONT },
      }),
      series: [
        {
          type: 'line',
          color: p[role],
          showSymbol: false,
          lineStyle: { width: 4 },
          areaStyle: { opacity: 0.12 },
          data: series.map((s) => s[role]),
        },
      ],
    }));

    return el(
      'div',
      { class: 'pcols pcols--chart' },
      chart,
      el(
        'div',
        { class: 'pstack' },
        compact(
          kpi(
            'Pico',
            marks.peak ? fmtSlot(marks.peak.start, SLOT) : '—',
            marks.peak ? `${fmtInt(marks.peak.count)} check-ins` : '',
          ),
        ),
        compact(kpi('50% às', fmtTime(marks.half), 'dos check-ins finais')),
        compact(kpi('90% às', fmtTime(marks.ninety), 'dos check-ins finais')),
        volunteerTimes.length > 0
          ? el(
              'p',
              { class: 'plabel plabel--line' },
              `Voluntários: ${fmtInt(volunteerTimes.length)} check-ins · ${fmtTime(Math.min(...volunteerTimes))}–${fmtTime(Math.max(...volunteerTimes))}`,
            )
          : null,
      ),
    );
  },
});

/** A slide chart under a visible caption, for charts shown side by side. */
const captioned = (
  label: string,
  option: Parameters<typeof slideChart>[1],
): HTMLElement =>
  el(
    'div',
    { class: 'pstack' },
    el('p', { class: 'plabel' }, label),
    slideChart(label, option),
  );

/** Redemptions of the chosen item every 5 minutes, beside their running total. */
export const redemptionTimelineSlide = (ctx: Ctx): Slide => {
  const item = chosenItem(ctx.rows);

  return {
    id: 'redemptionTimeline',
    layout: 'content',
    eyebrow: 'Retiradas',
    title: `Retiradas por horário · ${ITEM_LABELS[item]}`,
    note: null,
    render: () => {
      const series = redemptionSeries(ctx.rows, item, SLOT);
      const both = ctx.roles.length === 2;
      const axes = (p: Palette, boundaryGap: boolean) => ({
        grid: {
          left: 8,
          right: 32,
          top: 24,
          bottom: both && boundaryGap ? 56 : 8,
          containLabel: true,
        },
        xAxis: categoryAxis(p, slotLabels(series), {
          boundaryGap,
          axisLabel: { color: p.muted, fontSize: AXIS_FONT, hideOverlap: true },
        }),
        yAxis: valueAxis(p, {
          minInterval: 1,
          axisLabel: { color: p.muted, fontSize: AXIS_FONT },
        }),
      });

      return el(
        'div',
        { class: 'pcols pcols--even' },
        captioned('Retiradas a cada 5 minutos', (p) => ({
          ...axes(p, true),
          legend: {
            show: both,
            bottom: 0,
            itemWidth: 32,
            itemHeight: 20,
            textStyle: { color: p.muted, fontSize: LABEL_FONT },
          },
          series: roleBars(series, ctx.roles, p).map((r) => ({
            ...r,
            barMaxWidth: 72,
          })),
        })),
        captioned('Total acumulado', (p) => ({
          ...axes(p, false),
          series: [
            {
              type: 'line',
              color: p.accent,
              showSymbol: false,
              lineStyle: { width: 4 },
              areaStyle: { opacity: 0.12 },
              data: series.map((s) => s.cumulative),
            },
          ],
        })),
      );
    },
  };
};

/** Tickets sold per period before the event, with the last week in the note. */
export const salesSlide = (ctx: Ctx): Slide => {
  const rows = salesRows(ctx);
  const { dated, lastWeek, onDay } = summarise(rows);

  return {
    id: 'sales',
    layout: 'content',
    eyebrow: 'Vendas',
    title: 'Vendas de ingressos',
    note:
      dated === 0
        ? null
        : `Última semana: ${fmtInt(lastWeek)} (${fmtPercent(ratio(lastWeek, dated))}) · No dia: ${fmtInt(onDay)}`,
    render: () =>
      slideChart('Ingressos por período de venda', (p) =>
        salesOption(rows, p, {
          axisFont: SALES_AXIS_FONT,
          labelFont: LABEL_FONT,
          barMaxWidth: 72,
          rotate: 0,
          breakLabels: true,
          grid: { left: 8, right: 16, top: 48, bottom: 8 },
        }),
      ),
  };
};

/** Attendance per church, highlighting the filtered one. */
export const churchesSlide = (ctx: Ctx): Slide => ({
  id: 'churches',
  layout: 'content',
  eyebrow: 'Igrejas',
  title: 'Presença por igreja',
  note: null,
  render: () => {
    const unfiltered = applyFilters(ctx.data.attendees, {
      ...ctx.filters,
      excludedChurches: [],
    });
    const rows = topChurches(byChurch(unfiltered));
    const split = hostChurchSplit(
      applyFilters(ctx.data.attendees, ctx.filters),
      ctx.hostChurch,
    );
    const excluded = new Set(ctx.filters.excludedChurches.map(churchKey));
    const dimmed = (church: string): boolean => excluded.has(churchKey(church));
    const bars = (key: 'checkedIn' | 'absent') =>
      rows.map((r) => ({
        value: r[key],
        itemStyle: { opacity: dimmed(r.church) ? 0.3 : 1 },
        label: {
          color: dimmed(r.church) ? ctx.palette.muted : ctx.palette.text,
        },
      }));

    const chart = slideChart('Presença por igreja', (p) => ({
      legend: {
        top: 0,
        left: 0,
        itemWidth: 32,
        itemHeight: 20,
        textStyle: { color: p.muted, fontSize: LABEL_FONT },
      },
      grid: { left: 8, right: 250, top: 64, bottom: 8, containLabel: true },
      xAxis: valueAxis(p, {
        axisLabel: { color: p.muted, fontSize: AXIS_FONT },
      }),
      yAxis: categoryAxis(
        p,
        rows.map((r) => r.church),
        {
          inverse: true,
          axisLabel: {
            color: p.text,
            fontSize: LABEL_FONT,
            width: 460,
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
          barMaxWidth: 40,
          color: p.accent,
          data: bars('checkedIn'),
        },
        {
          type: 'bar',
          name: 'Ausentes',
          stack: 'church',
          ...barStyle(p, true),
          barMaxWidth: 40,
          color: p.borderStrong,
          label: {
            show: true,
            position: 'right',
            fontSize: LABEL_FONT,
            formatter: (q: { dataIndex: number }) =>
              `${fmtPercent(rows[q.dataIndex]?.noShowRate ?? null)} quebra`,
          },
          data: bars('absent'),
        },
      ],
    }));

    if (!split || ctx.hostChurch === null) return chart;
    const splitNote = hostNote(split);

    return el(
      'div',
      { class: 'pcols pcols--chart' },
      chart,
      el(
        'div',
        { class: 'pstack pstack--split' },
        ...hostTiles(split, ctx.hostChurch),
        splitNote ? el('p', { class: 'plabel' }, splitNote) : null,
      ),
    );
  },
});

/** Attendance per age group, highlighting the filtered ranges. */
export const agesSlide = (ctx: Ctx): Slide => ({
  id: 'ages',
  layout: 'content',
  eyebrow: 'Perfil',
  title: 'Participantes por idade',
  note: null,
  render: () => {
    const rows = byAgeDetail(
      applyFilters(ctx.data.attendees, { ...ctx.filters, age: [] }),
    );
    const selected = ctx.filters.age;
    const dimmed = (r: AgeDetailRow): boolean =>
      selected.length > 0 && !selected.includes(r.band ?? UNKNOWN_AGE);
    const bars = (key: 'checkedIn' | 'absent') =>
      rows.map((r) => ({
        value: r[key],
        itemStyle: { opacity: dimmed(r) ? 0.3 : 1 },
        label: {
          color: dimmed(r) ? ctx.palette.muted : ctx.palette.text,
        },
      }));

    return slideChart('Presença por faixa etária', (p) => ({
      legend: {
        top: 0,
        left: 0,
        itemWidth: 32,
        itemHeight: 20,
        textStyle: { color: p.muted, fontSize: LABEL_FONT },
      },
      grid: { left: 8, right: 8, top: 96, bottom: 8, containLabel: true },
      xAxis: categoryAxis(
        p,
        rows.map((r) => r.detail),
        {
          axisLabel: {
            color: p.text,
            fontSize: AGE_AXIS_FONT,
            interval: 0,
            width: 170,
            overflow: 'break',
          },
        },
      ),
      yAxis: valueAxis(p, {
        minInterval: 1,
        axisLabel: { color: p.muted, fontSize: AGE_AXIS_FONT },
      }),
      series: [
        {
          type: 'bar',
          name: 'Presentes',
          stack: 'age',
          ...barStyle(p),
          barMaxWidth: 96,
          color: p.accent,
          data: bars('checkedIn'),
        },
        {
          type: 'bar',
          name: 'Ausentes',
          stack: 'age',
          ...barStyle(p),
          barMaxWidth: 96,
          color: p.borderStrong,
          data: bars('absent'),
        },
      ],
    }));
  },
});

/** The overall score: mean, response rate and the three score bands. */
export const scoreSlide = (ctx: Ctx): Slide => ({
  id: 'participantScore',
  layout: 'content',
  eyebrow: 'Questionário · Participantes',
  title: 'Nota geral',
  note: surveyNote(ctx),
  render: () => {
    const survey = participantSurvey(ctx);
    const general = survey
      ? ratingStats(survey).find((s) => s.id === OVERALL)
      : undefined;

    if (!survey || !general) return el('div');
    const rate = responseRate(
      survey.responses,
      ticketSummary(ctx.data.attendees).checkedIn,
    );
    const bands = scoreBands(
      survey.responses.flatMap((r) =>
        typeof r.answers[OVERALL] === 'number' ? [r.answers[OVERALL]] : [],
      ),
    );
    const entries = [
      { name: '9–10', band: bands.high, color: ctx.palette.success },
      { name: '7–8', band: bands.mid, color: ctx.palette.warn },
      { name: '≤ 6', band: bands.low, color: ctx.palette.error },
    ];

    return el(
      'div',
      { class: 'pscore' },
      el(
        'div',
        { class: 'pscore-head' },
        el(
          'div',
          { class: 'pscore-mean' },
          fmtDecimal(general.mean),
          el('span', { class: 'pscore-max' }, '/10'),
        ),
        el(
          'p',
          { class: 'pbody' },
          `${fmtInt(survey.responses.length)} respostas · ${fmtPercent(rate)} de resposta`,
        ),
      ),
      slideChart(
        'Nota geral por faixa',
        (p) => ({
          legend: {
            bottom: 0,
            itemWidth: 32,
            itemHeight: 20,
            textStyle: { color: p.muted, fontSize: LABEL_FONT },
          },
          grid: { left: 0, right: 0, top: 8, bottom: 56 },
          xAxis: { type: 'value', max: 100, show: false },
          yAxis: { type: 'category', data: [''], show: false },
          series: entries.map((e) => ({
            type: 'bar',
            name: e.name,
            stack: 'bands',
            color: e.color,
            barWidth: 120,
            itemStyle: {
              borderColor: p.surface,
              borderWidth: 2,
              borderRadius: 6,
            },
            label: {
              show: true,
              color: p.surface,
              fontSize: LABEL_FONT,
              fontWeight: 600,
              formatter: () =>
                (e.band.share ?? 0) < 0.04 ? '' : fmtPercent(e.band.share),
            },
            data: [(e.band.share ?? 0) * 100],
          })),
        }),
        'pchart--band',
      ),
    );
  },
});

/** Horizontal bars of mean score per question, with wrapped labels. */
const rankingChart = (ctx: Ctx, pick: (g: GroupedRatings) => RatingStat[]) => {
  const survey = participantSurvey(ctx);
  const ranking = survey ? pick(groupRatings(ratingStats(survey))) : [];

  return slideChart('Média por pergunta', (p) => ({
    // Fixed gutter for the wrapped labels (620px wide plus margin).
    grid: { left: 664, right: 90, top: 4, bottom: 4, containLabel: false },
    xAxis: valueAxis(p, { min: 0, max: 10, show: false }),
    yAxis: categoryAxis(
      p,
      ranking.map((s) => s.label),
      {
        inverse: true,
        axisLabel: {
          color: p.text,
          fontSize: AXIS_FONT,
          lineHeight: 30,
          width: 620,
          overflow: 'break',
        },
      },
    ),
    series: [
      {
        type: 'bar',
        color: p.participant,
        ...barStyle(p, true),
        barMaxWidth: 36,
        label: {
          show: true,
          position: 'right',
          color: p.text,
          fontSize: LABEL_FONT,
          fontWeight: 600,
          formatter: (q: { dataIndex: number }) =>
            fmtDecimal(ranking[q.dataIndex]?.mean ?? null),
        },
        data: ranking.map((s) => s.mean),
      },
    ],
  }));
};

/** Mean of each attraction question, best first. */
export const rankingSlide = (ctx: Ctx): Slide => ({
  id: 'ranking',
  layout: 'content',
  eyebrow: 'Questionário · Participantes',
  title: 'Avaliação das atrações',
  note: surveyNote(ctx),
  render: () => rankingChart(ctx, (g) => g.attractions),
});

/** Mean of each event-structure question, best first. */
export const structureSlide = (ctx: Ctx): Slide => ({
  id: 'structure',
  layout: 'content',
  eyebrow: 'Questionário · Participantes',
  title: 'Estrutura do evento',
  note: surveyNote(ctx),
  render: () => rankingChart(ctx, (g) => g.structure),
});
