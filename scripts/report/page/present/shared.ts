import { ignoredBySurveys } from '../../core/filter.ts';
import { chartBox } from '../charts.ts';

import type { SurveyData } from '../../core/survey.ts';
import type { Ctx } from '../ctx.ts';
import type { Palette } from '../theme.ts';

// The package root's typings use `export =`, which NodeNext rejects in ESM;
// the dist typings are the same declarations.
import type * as Echarts from 'echarts/types/dist/echarts';

type EChartsOption = Echarts.EChartsOption;

/** Smallest axis and legend text on a 1080p slide. */
export const AXIS_FONT = 24;
/** Direct labels on bars and areas. */
export const LABEL_FONT = 26;

const SURVEY_NOTE =
  'Questionário anônimo: os filtros de igreja, idade e ingresso não se aplicam.';

/** The participant survey, unless the audience filter excludes it. */
export const participantSurvey = (ctx: Ctx): SurveyData | null =>
  ctx.filters.audience === 'volunteer' ? null : ctx.data.surveys.participant;

/** The volunteer survey, unless the audience filter excludes it. */
export const volunteerSurvey = (ctx: Ctx): SurveyData | null =>
  ctx.filters.audience === 'participant' ? null : ctx.data.surveys.volunteer;

/** Explains why survey slides ignore church, age and ticket filters, if changed. */
export const surveyNote = (ctx: Ctx): string | null =>
  ignoredBySurveys(ctx.filters) ? SURVEY_NOTE : null;

/**
 * A chart that fills its container, without tooltip or animation.
 *
 * @param label - Accessible name.
 * @param option - Builds the ECharts option from the resolved palette.
 * @param className - Extra class for sizing.
 */
export const slideChart = (
  label: string,
  option: (palette: Palette) => EChartsOption,
  className?: string,
): HTMLElement => {
  const host = chartBox(label, (palette) => ({
    animation: false,
    tooltip: { show: false },
    ...option(palette),
  }));

  host.classList.add('pchart');
  if (className !== undefined) host.classList.add(className);

  return host;
};

/** Shrinks a KPI tile's value to the secondary size. */
export const compact = (tile: HTMLElement): HTMLElement => {
  tile.classList.add('kpi--sm');

  return tile;
};
