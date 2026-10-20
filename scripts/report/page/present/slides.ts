import { COPY_DEFAULTS } from '../../../../src/constants/copy-defaults.ts';
import { deckOutline, eventDay } from '../../core/deck.ts';
import {
  byArea,
  redeemedItems,
  ratingStats,
  responseRate,
  ticketSummary,
  volunteerSummary,
  yesNoStats,
} from '../../core/metrics.ts';
import { selectSlides } from '../../core/selection.ts';
import { el } from '../dom.ts';
import {
  fmtDecimal,
  fmtInt,
  fmtLongDate,
  fmtPercent,
  ratio,
} from '../format.ts';
import { state } from '../state.ts';
import { bar, itemCard, kpi, table } from '../ui.ts';
import {
  agesSlide,
  checkinSlide,
  churchesSlide,
  rankingSlide,
  redemptionTimelineSlide,
  salesSlide,
  scoreSlide,
  structureSlide,
} from './chart-slides.ts';
import { RESUMO_EYEBROW, RESUMO_TITLE, resumoPages } from './resumo.ts';
import {
  compact,
  participantSurvey,
  surveyNote,
  volunteerSurvey,
} from './shared.ts';

import type { SlideId } from '../../core/deck.ts';
import type { Ctx } from '../ctx.ts';
import type { Slide } from './types.ts';

/** Smallest group the volunteer area table may show. */
const AREA_MIN = 5;

const ROLE_NAME = {
  participant: 'Participante',
  volunteer: 'Voluntário',
} as const;

const content = (
  id: SlideId,
  eyebrow: string | null,
  title: string,
  note: string | null,
  render: () => HTMLElement,
): Slide => ({ id, layout: 'content', eyebrow, title, note, render });

const cover = (ctx: Ctx): Slide => ({
  id: 'cover',
  layout: 'cover',
  eyebrow: null,
  title: COPY_DEFAULTS.eventName,
  note: null,
  render: () => {
    const day = eventDay(ctx.data.attendees);

    return el(
      'div',
      { class: 'pcover' },
      el('h2', { class: 'pcover-title' }, COPY_DEFAULTS.eventName),
      el('p', { class: 'pcover-sub' }, 'Resultados do evento'),
      day === null ? null : el('p', { class: 'pbody' }, fmtLongDate(day)),
    );
  },
});

const closing = (): Slide => ({
  id: 'closing',
  layout: 'cover',
  eyebrow: null,
  title: 'Obrigado',
  note: null,
  render: () =>
    el(
      'div',
      { class: 'pcover' },
      el('h2', { class: 'pcover-title' }, 'Obrigado'),
      el('p', { class: 'pcover-sub' }, COPY_DEFAULTS.eventName),
      el('p', { class: 'pcover-credit' }, 'Produzido por Josh Porter'),
    ),
});

const attendance = (ctx: Ctx): Slide =>
  content('attendance', 'Presença', 'Ingressos e presença', null, () => {
    const t = ticketSummary(ctx.rows);
    const split =
      t.preSale && t.walkIn
        ? `Antecipados: ${fmtPercent(t.preSale.noShowRate)} de quebra · No dia: ${fmtPercent(t.walkIn.noShowRate)} de quebra`
        : null;

    return el(
      'div',
      { class: 'pattendance' },
      el(
        'div',
        { class: 'kpis kpis--2' },
        kpi(
          'Ingressos comprados',
          fmtInt(t.tickets),
          t.walkIns === null ? '' : `${fmtInt(t.walkIns)} comprados no dia`,
        ),
        kpi(
          'Check-ins',
          fmtInt(t.checkedIn),
          `${fmtPercent(ratio(t.checkedIn, t.tickets))} dos ingressos`,
        ),
        kpi('Ausentes', fmtInt(t.absent), 'sem check-in'),
        kpi('% de quebra', fmtPercent(t.noShowRate), 'ausentes ÷ ingressos'),
      ),
      split === null ? null : el('p', { class: 'plabel' }, split),
    );
  });

const redemptions = (ctx: Ctx): Slide =>
  content('redemptions', 'Retiradas', 'Retirada de itens', null, () => {
    const items = redeemedItems(ctx.rows);
    const columns = items.length <= 1 ? 1 : items.length <= 4 ? 2 : 3;

    return el(
      'div',
      {
        class: `pitems pitems--${String(columns)}${items.length > 2 ? ' pitems--dense' : ''}`,
      },
      ...items.map((r) => itemCard(r, ROLE_NAME[r.role], ctx.palette[r.role])),
    );
  });

const yesNo = (ctx: Ctx): Slide =>
  content(
    'yesNo',
    'Questionário · Participantes',
    'Voltariam e convidariam',
    surveyNote(ctx),
    () => {
      const survey = participantSurvey(ctx);
      const stats = survey ? yesNoStats(survey).filter((s) => s.n > 0) : [];

      return el(
        'div',
        { class: `pyesno pyesno--${String(Math.min(stats.length, 4))}` },
        ...stats.map((s) => {
          const tile = kpi(
            s.label,
            fmtPercent(s.yesShare),
            `sim · n=${fmtInt(s.n)}`,
          );

          tile.append(bar(s.yesShare, ctx.palette.participant));

          return tile;
        }),
      );
    },
  );

const volunteers = (ctx: Ctx): Slide =>
  content(
    'volunteers',
    'Voluntários',
    'Voluntários',
    volunteerSurvey(ctx) ? surveyNote(ctx) : null,
    () => {
      const summary = volunteerSummary(ctx.rows);
      const survey = volunteerSurvey(ctx);
      const tiles: HTMLElement[] = [];

      if (ctx.roles.includes('volunteer') && summary.total > 0) {
        tiles.push(
          compact(
            kpi(
              'Presentes',
              `${fmtInt(summary.checkedIn)} de ${fmtInt(summary.total)}`,
              'voluntários com check-in',
            ),
          ),
        );
      }
      if (survey) {
        const present = volunteerSummary(ctx.data.attendees).checkedIn;

        tiles.push(
          ...ratingStats(survey)
            .filter((s) => s.n > 0)
            .map((s) =>
              compact(kpi(s.label, fmtDecimal(s.mean), `n=${fmtInt(s.n)}`)),
            ),
          compact(
            kpi(
              'Taxa de resposta',
              fmtPercent(responseRate(survey.responses, present)),
              `${fmtInt(survey.responses.length)} respostas de ${fmtInt(present)} check-ins`,
            ),
          ),
        );
      }

      return el(
        'div',
        { class: `kpis kpis--${String(tiles.length > 6 ? 4 : 3)}` },
        ...tiles,
      );
    },
  );

const areas = (ctx: Ctx): Slide =>
  content(
    'areas',
    'Questionário · Voluntários',
    'Voluntários por área',
    surveyNote(ctx),
    () => {
      const survey = volunteerSurvey(ctx);

      if (!survey) return el('div');
      const breakdown = byArea(survey, AREA_MIN);
      const ratings = ratingStats(survey).filter((s) => s.n > 0);

      return el(
        'div',
        { class: 'pareas' },
        table(
          'Médias por área',
          ['Área', 'n', ...ratings.map((s) => s.label)],
          breakdown.areas.map((a) => [
            a.area,
            fmtInt(a.n),
            ...ratings.map((s) => fmtDecimal(a.means[s.id] ?? null)),
          ]),
          [],
          true,
        ),
        el(
          'p',
          { class: 'plabel' },
          `Áreas com menos de ${String(AREA_MIN)} respostas não são exibidas (${fmtInt(breakdown.suppressedCount)} ocultas).`,
        ),
      );
    },
  );

/** One slide per page of the summary, titled "(2/3)" when there are several. */
const resumo = (ctx: Ctx): Slide[] => {
  const pages = resumoPages(ctx, ctx.data.resumoHtml ?? '');

  return pages.map((blocks, i) =>
    content(
      'resumo',
      RESUMO_EYEBROW,
      pages.length > 1
        ? `${RESUMO_TITLE} (${String(i + 1)}/${String(pages.length)})`
        : RESUMO_TITLE,
      null,
      () => el('div', { class: 'pprose' }, ...blocks),
    ),
  );
};

const BUILDERS: Record<Exclude<SlideId, 'resumo'>, (ctx: Ctx) => Slide> = {
  cover,
  attendance,
  sales: salesSlide,
  checkin: checkinSlide,
  redemptions,
  redemptionTimeline: redemptionTimelineSlide,
  churches: churchesSlide,
  ages: agesSlide,
  participantScore: scoreSlide,
  ranking: rankingSlide,
  structure: structureSlide,
  yesNo,
  volunteers,
  areas,
  closing,
};

/** What the picker shows for one slide. */
export interface SlideChoice {
  id: SlideId;
  eyebrow: string | null;
  title: string;
}

/**
 * Lists the slides available under the current filters, one entry per slide
 * (the summary counts once however many pages it spans).
 *
 * @param ctx - The context the tabs use.
 * @returns Entries in presentation order, titled as the slides are.
 */
export const slideChoices = (ctx: Ctx): SlideChoice[] =>
  deckOutline(ctx.data, ctx.filters).map((id) => {
    if (id === 'resumo') {
      return { id, eyebrow: RESUMO_EYEBROW, title: RESUMO_TITLE };
    }
    const { eyebrow, title } = BUILDERS[id](ctx);

    return { id, eyebrow, title };
  });

/**
 * Builds the deck for the current filters and the saved selection.
 *
 * Falls back to every available slide when the selection leaves none, as can
 * happen after the filters change.
 *
 * @param ctx - The context the tabs use.
 * @returns Slides in presentation order.
 */
export const buildDeck = (ctx: Ctx): Slide[] => {
  const outline = deckOutline(ctx.data, ctx.filters);
  const chosen = selectSlides(outline, state.excludedSlides);

  return (chosen.length > 0 ? chosen : outline).flatMap((id) =>
    id === 'resumo' ? resumo(ctx) : [BUILDERS[id](ctx)],
  );
};
