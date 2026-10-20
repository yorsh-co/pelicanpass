import {
  byArea,
  rankByMean,
  ratingStats,
  responseRate,
  scoreBands,
  textAnswers,
  ticketSummary,
  volunteerSummary,
  yesNoStats,
} from '../core/metrics.ts';
import { groupRatings } from '../core/rating-groups.ts';
import {
  axisTip,
  barStyle,
  categoryAxis,
  chartCard,
  tooltip,
  valueAxis,
} from './charts.ts';
import { ignoredBySurveys } from '../core/filter.ts';
import { el, escapeHtml } from './dom.ts';
import { fmtDecimal, fmtInt, fmtPercent } from './format.ts';
import { state, update } from './state.ts';
import { bar, card, kpi, note, select, table } from './ui.ts';

import type { RatingStat } from '../core/metrics.ts';
import type { SurveyData } from '../core/survey.ts';
import type { Ctx } from './ctx.ts';

type Audience = 'participant' | 'volunteer';

const NAMES: Record<Audience, string> = {
  participant: 'Participantes',
  volunteer: 'Voluntários',
};

const AREA_MIN = 5;

/** One audience's section. */
const section = (
  ctx: Ctx,
  audience: Audience,
  survey: SurveyData,
): HTMLElement => {
  const { palette } = ctx;
  const color = palette[audience];
  const stats = ratingStats(survey);
  const general = stats.find((s) => s.id === 'overall_rating');
  const present =
    audience === 'participant'
      ? ticketSummary(ctx.data.attendees).checkedIn
      : volunteerSummary(ctx.data.attendees).checkedIn;
  const rate = responseRate(survey.responses, present);
  const parts: HTMLElement[] = [];

  parts.push(
    el(
      'div',
      { class: 'kpis' },
      kpi('Respostas', fmtInt(survey.responses.length), NAMES[audience]),
      kpi(
        'Taxa de resposta',
        fmtPercent(rate),
        `de ${fmtInt(present)} check-ins`,
      ),
      general
        ? kpi(
            'Média geral',
            fmtDecimal(general.mean),
            `overall_rating · n=${fmtInt(general.n)}`,
          )
        : null,
    ),
  );

  const cards: HTMLElement[] = [];

  if (general) {
    const values = survey.responses.flatMap((r) =>
      typeof r.answers.overall_rating === 'number'
        ? [r.answers.overall_rating]
        : [],
    );
    const bands = scoreBands(values);
    const entries = [
      { name: '9–10', band: bands.high, color: palette.success },
      { name: '7–8', band: bands.mid, color: palette.warn },
      { name: '≤ 6', band: bands.low, color: palette.error },
    ];

    cards.push(
      chartCard({
        id: `bands-${audience}`,
        title: 'Nota geral',
        span: 12,
        height: 96,
        table: {
          caption: 'Nota geral por faixa',
          head: ['Faixa', 'Respostas', '%'],
          rows: entries.map((e) => [
            e.name,
            fmtInt(e.band.count),
            fmtPercent(e.band.share),
          ]),
        },
        option: (p) => ({
          tooltip: tooltip(p, {
            trigger: 'item',
            formatter: (raw: unknown) => {
              const q = raw as {
                seriesName: string;
                value: number;
                marker: string;
              };
              return `${q.marker}${escapeHtml(q.seriesName)}: ${escapeHtml(fmtPercent(q.value / 100))}`;
            },
          }),
          legend: { bottom: 0, textStyle: { color: p.muted } },
          grid: { left: 8, right: 8, top: 4, bottom: 30, containLabel: false },
          xAxis: { type: 'value', max: 100, show: false },
          yAxis: { type: 'category', data: [''], show: false },
          series: entries.map((e) => ({
            type: 'bar',
            name: e.name,
            stack: 'bands',
            color: e.color,
            barWidth: 28,
            itemStyle: {
              borderColor: p.surface,
              borderWidth: 1,
              borderRadius: 4,
            },
            label: {
              show: true,
              color: p.surface,
              fontSize: 11,
              formatter: () =>
                (e.band.share ?? 0) < 0.06 ? '' : fmtPercent(e.band.share),
            },
            data: [(e.band.share ?? 0) * 100],
          })),
        }),
      }),
    );
  }

  const ranked = rankByMean(stats).filter((s) => s.n > 0);
  const ranking = ranked.filter((s) => s.id !== 'overall_rating');

  const rankingCard = (
    id: string,
    title: string,
    ranking: RatingStat[],
  ): HTMLElement =>
    chartCard({
      id,
      title,
      span: 12,
      height: Math.max(140, ranking.length * 40 + 24),
      table: {
        caption: 'Média por pergunta',
        head: ['Pergunta', 'Média', 'n'],
        rows: ranking.map((s) => [s.label, fmtDecimal(s.mean), fmtInt(s.n)]),
      },
      option: (p) => ({
        tooltip: tooltip(p, {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (raw: unknown) => {
            const q = (Array.isArray(raw) ? raw[0] : raw) as {
              dataIndex: number;
            };
            const s = ranking[q.dataIndex];
            return s
              ? `<strong>${escapeHtml(s.label)}</strong><br/>Média ${escapeHtml(fmtDecimal(s.mean))} (n=${fmtInt(s.n)})`
              : '';
          },
        }),
        grid: { left: 8, right: 70, top: 4, bottom: 4, containLabel: true },
        xAxis: valueAxis(p, { min: 0, max: 10, show: false }),
        yAxis: categoryAxis(
          p,
          ranking.map((s) => s.label),
          {
            inverse: true,
            axisLabel: {
              color: p.muted,
              fontSize: 11,
              width: window.innerWidth < 600 ? 150 : 340,
              height: 28,
              lineHeight: 14,
              overflow: 'break',
              lineOverflow: 'truncate',
              ellipsis: '…',
            },
          },
        ),
        series: [
          {
            type: 'bar',
            color,
            ...barStyle(p, true),
            barMaxWidth: 12,
            label: {
              show: true,
              position: 'right',
              color: p.text,
              fontSize: 11,
              formatter: (q: { dataIndex: number }) => {
                const s = ranking[q.dataIndex];
                return s ? `${fmtDecimal(s.mean)} (n=${fmtInt(s.n)})` : '';
              },
            },
            data: ranking.map((s) => s.mean),
          },
        ],
      }),
    });

  if (audience === 'participant') {
    const groups = groupRatings(stats);

    for (const [id, title, rows] of [
      ['attractions', 'Atrações', groups.attractions],
      ['structure', 'Estrutura do evento', groups.structure],
      ['other', 'Outras avaliações', groups.other],
    ] as const) {
      if (rows.length > 0) {
        cards.push(rankingCard(`ranking-${id}-${audience}`, title, rows));
      }
    }
  } else if (ranking.length > 0) {
    cards.push(
      rankingCard(`ranking-${audience}`, 'Ranking das avaliações', ranking),
    );
  }

  if (ranked.length > 0) {
    const chosen =
      state.distribution[audience] ??
      (ranked.find((s) => s.id === 'overall_rating') ?? ranked[0])?.id;
    const stat = ranked.find((s) => s.id === chosen) ?? ranked[0];

    if (stat) {
      cards.push(
        chartCard({
          id: `distribution-${audience}`,
          title: 'Distribuição das notas',
          span: 12,
          height: 220,
          extra: [
            select(
              'Pergunta',
              ranked.map((s) => ({
                value: s.id,
                label:
                  s.label.length > 70 ? `${s.label.slice(0, 69)}…` : s.label,
              })),
              stat.id,
              (value) => {
                update({
                  distribution: { ...state.distribution, [audience]: value },
                });
              },
            ),
          ],
          table: {
            caption: `Distribuição de ${stat.label}`,
            head: ['Nota', 'Respostas'],
            rows: stat.distribution.map((n, i) => [String(i + 1), fmtInt(n)]),
          },
          option: (p) => ({
            tooltip: tooltip(p, {
              trigger: 'axis',
              axisPointer: { type: 'shadow' },
              formatter: axisTip(
                (i) => `Nota ${String(i + 1)}`,
                (v) => `${fmtInt(Number(v))} respostas`,
              ),
            }),
            grid: {
              left: 8,
              right: 12,
              top: 12,
              bottom: 8,
              containLabel: true,
            },
            xAxis: categoryAxis(
              p,
              stat.distribution.map((_, i) => String(i + 1)),
            ),
            yAxis: valueAxis(p),
            series: [
              {
                type: 'bar',
                name: 'Respostas',
                color,
                ...barStyle(p),
                data: stat.distribution,
              },
            ],
          }),
        }),
      );
    }
  }
  if (cards.length > 0) parts.push(el('div', { class: 'grid' }, ...cards));

  const yesNo = yesNoStats(survey).filter((s) => s.n > 0);
  const reasons =
    audience === 'participant'
      ? textAnswers(survey).find((t) => t.id === 'why_not_invite')
      : undefined;

  if (yesNo.length > 0) {
    parts.push(
      el(
        'div',
        { class: 'kpis' },
        ...yesNo.map((s) => {
          const tile = kpi(
            s.label,
            fmtPercent(s.yesShare),
            `sim · n=${fmtInt(s.n)}`,
          );

          tile.append(bar(s.yesShare, color));
          if (
            s.id === 'would_invite' &&
            reasons &&
            reasons.answers.length > 0
          ) {
            tile.append(
              el(
                'p',
                { class: 'kpi-sub' },
                `Por que não convidaria: ${fmtInt(reasons.answers.length)} respostas`,
              ),
              el(
                'ul',
                { class: 'reasons' },
                ...reasons.answers.map((a) => el('li', {}, a)),
              ),
            );
          }

          return tile;
        }),
      ),
    );
  }

  if (audience === 'volunteer') {
    const areas = byArea(survey, AREA_MIN);
    const ratings = stats.filter((s) => s.n > 0);

    if (survey.questions.some((q) => q.id === 'volunteer_area')) {
      const wrap = card('Por área', 12, [
        table(
          'Médias por área',
          ['Área', 'n', ...ratings.map((s) => s.label)],
          areas.areas.map((a) => [
            a.area,
            fmtInt(a.n),
            ...ratings.map((s) => fmtDecimal(a.means[s.id] ?? null)),
          ]),
          [],
          true,
        ),
        note(
          `Áreas com menos de ${String(AREA_MIN)} respostas não são exibidas (${fmtInt(areas.suppressedCount)} ocultas).`,
        ),
        el(
          'details',
          { class: 'unmatched' },
          el(
            'summary',
            {},
            `Respostas sem área identificada (${fmtInt(areas.unmatched.length)})`,
          ),
          el('ul', {}, ...areas.unmatched.map((u) => el('li', {}, u))),
        ),
      ]);

      parts.push(el('div', { class: 'grid' }, wrap));
    }
  }

  return el(
    'section',
    { class: 'audience' },
    el('h2', { class: 'section-title' }, NAMES[audience]),
    ...parts,
  );
};

/** The "Questionário" tab. */
export const survey = (ctx: Ctx): HTMLElement => {
  const { data, filters } = ctx;
  const audiences = (['participant', 'volunteer'] as const).filter(
    (a) =>
      (filters.audience === 'all' || filters.audience === a) && data.surveys[a],
  );
  const parts: (HTMLElement | null)[] = [];

  if (ignoredBySurveys(filters)) {
    parts.push(
      note(
        'Os questionários são anônimos: os filtros de igreja, idade e ingresso não se aplicam aqui.',
      ),
    );
  }
  if (data.resumoHtml !== null) {
    const body = el('div', { class: 'prose' });

    body.innerHTML = data.resumoHtml;
    parts.push(
      el('div', { class: 'grid' }, card('Resumo do feedback', 12, [body])),
    );
  }
  if (audiences.length === 0) {
    parts.push(note('Nenhuma pesquisa carregada para este público.'));
  }
  for (const audience of audiences) {
    const loaded = data.surveys[audience];

    if (loaded) parts.push(section(ctx, audience, loaded));
  }

  return el('div', { class: 'stack' }, ...parts);
};
