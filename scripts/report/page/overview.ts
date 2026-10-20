import {
  ratingStats,
  responseRate,
  ticketSummary,
  volunteerSummary,
  checkinSeries,
} from '../core/metrics.ts';
import {
  chartCard,
  axisTip,
  categoryAxis,
  slotHeading,
  slotLabels,
  tooltip,
  valueAxis,
} from './charts.ts';
import { el } from './dom.ts';
import { fmtDecimal, fmtInt, fmtPercent, fmtSlot, ratio } from './format.ts';
import { update } from './state.ts';
import { kpi } from './ui.ts';

import type { Ctx } from './ctx.ts';

/** Check-in runs for at most about 90 minutes, so 5-minute points show its shape. */
const SLOT = 5;

const ROLE_LABELS = {
  participant: 'Participantes',
  volunteer: 'Voluntários',
} as const;

/** The overall mean of `overall_rating` for participants. */
const overallMean = (ctx: Ctx): { mean: number | null; n: number } | null => {
  const survey = ctx.data.surveys.participant;
  const stat =
    survey && ratingStats(survey).find((s) => s.id === 'overall_rating');

  return stat ? { mean: stat.mean, n: stat.n } : null;
};

/** The "Visão geral" tab. */
export const overview = (ctx: Ctx): HTMLElement => {
  const { rows, roles, data, filters } = ctx;
  const showParticipants = roles.includes('participant');
  const showVolunteers = roles.includes('volunteer');
  const tickets = ticketSummary(rows);
  const volunteers = volunteerSummary(rows);
  const tiles: (HTMLElement | null)[] = [];

  if (showParticipants) {
    tiles.push(
      kpi(
        'Ingressos comprados',
        fmtInt(tickets.tickets),
        tickets.walkIns === null
          ? 'Origem desconhecida'
          : `${fmtInt(tickets.walkIns)} no dia`,
      ),
      kpi(
        'Check-ins',
        fmtInt(tickets.checkedIn),
        `${fmtPercent(ratio(tickets.checkedIn, tickets.tickets))} dos ingressos`,
      ),
      kpi(
        'Ausentes',
        fmtInt(tickets.absent),
        `${fmtPercent(tickets.noShowRate)} de quebra`,
      ),
    );
  }
  if (showVolunteers) {
    tiles.push(
      kpi(
        'Voluntários presentes',
        fmtInt(volunteers.checkedIn),
        `${fmtInt(volunteers.checkedIn)} de ${fmtInt(volunteers.total)}`,
      ),
    );
  }
  const audiences = (['participant', 'volunteer'] as const).filter(
    (a) => filters.audience === 'all' || filters.audience === a,
  );
  const surveys = audiences.flatMap((a) => {
    const survey = data.surveys[a];

    if (!survey) return [];
    const present =
      a === 'participant'
        ? ticketSummary(data.attendees).checkedIn
        : volunteerSummary(data.attendees).checkedIn;

    return [
      {
        audience: a,
        count: survey.responses.length,
        rate: responseRate(survey.responses, present),
      },
    ];
  });

  if (surveys.length > 0) {
    tiles.push(
      kpi(
        'Resposta ao questionário',
        fmtInt(surveys.reduce((sum, s) => sum + s.count, 0)),
        surveys
          .map(
            (s) =>
              `${s.audience === 'participant' ? 'participantes' : 'voluntários'} ${fmtPercent(s.rate)}`,
          )
          .join(' · '),
      ),
    );
  }
  const overall = filters.audience === 'volunteer' ? null : overallMean(ctx);

  if (overall)
    tiles.push(
      kpi(
        'Nota geral média',
        fmtDecimal(overall.mean),
        `participantes, de 10 (n=${fmtInt(overall.n)})`,
      ),
    );

  // One chart per audience: volunteers arrive hours before participants, and a
  // shared time axis would squeeze the participants' window into a corner.
  const charts = roles.map((role, index) => {
    const series = checkinSeries(
      rows.filter((a) => a.role === role),
      SLOT,
    );

    return chartCard({
      id: `overview-checkin-${role}`,
      title: `Check-in · ${ROLE_LABELS[role]}`,
      span: roles.length === 1 ? 12 : role === 'participant' ? 8 : 4,
      height: 220,
      table: {
        caption: `Check-ins de ${ROLE_LABELS[role].toLowerCase()} a cada ${String(SLOT)} minutos`,
        head: ['Horário', 'Check-ins'],
        rows: series.map((s) => [fmtSlot(s.start, SLOT), fmtInt(s[role])]),
      },
      extra:
        index === 0
          ? [
              el(
                'button',
                {
                  class: 'link-button',
                  attrs: { type: 'button' },
                  on: {
                    click: () => {
                      update({ tab: 'checkin' });
                    },
                  },
                },
                'Ver detalhes em Check-in',
              ),
            ]
          : [],
      option: (p) => ({
        tooltip: tooltip(p, {
          trigger: 'axis',
          axisPointer: { type: 'line', lineStyle: { color: p.borderStrong } },
          formatter: axisTip(slotHeading(series, SLOT)),
        }),
        grid: { left: 8, right: 20, top: 12, bottom: 8, containLabel: true },
        xAxis: categoryAxis(p, slotLabels(series), {
          boundaryGap: false,
          axisLabel: { color: p.muted, fontSize: 11, hideOverlap: true },
        }),
        yAxis: valueAxis(p, { minInterval: 1 }),
        series: [
          {
            type: 'line',
            name: 'Check-ins',
            color: p[role],
            showSymbol: false,
            symbolSize: 6,
            lineStyle: { width: 2 },
            areaStyle: { opacity: 0.12 },
            data: series.map((s) => s[role]),
          },
        ],
      }),
    });
  });

  return el(
    'div',
    { class: 'stack' },
    el('div', { class: 'kpis' }, ...tiles),
    el('div', { class: 'grid' }, ...charts),
  );
};
