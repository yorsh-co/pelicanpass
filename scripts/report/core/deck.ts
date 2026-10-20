import { ageBandOf, ageLabel } from './age.ts';
import { activeRoles, applyFilters, isChurchFilterDefault } from './filter.ts';
import { churchKey } from './metrics.ts';
import { groupRatings } from './rating-groups.ts';
import {
  byArea,
  ratingStats,
  redeemedItems,
  ticketSummary,
  volunteerSummary,
  yesNoStats,
} from './metrics.ts';

import type { Attendee } from './checkin.ts';
import type { Filters } from './filter.ts';
import type { ChurchRow } from './metrics.ts';
import type { ReportData } from './model.ts';

/** Slides of the presentation, in the order they are shown. */
export const SLIDE_IDS = [
  'cover',
  'attendance',
  'sales',
  'checkin',
  'churches',
  'ages',
  'redemptions',
  'redemptionTimeline',
  'participantScore',
  'yesNo',
  'ranking',
  'structure',
  'volunteers',
  'areas',
  'resumo',
  'closing',
] as const;

/** One slide of the presentation. */
export type SlideId = (typeof SLIDE_IDS)[number];

/** Name of the row that groups the churches beyond the first `n`. */
export const OTHER_CHURCHES = 'Outras';

/** Rating question that holds the overall score. */
const OVERALL = 'overall_rating';

/**
 * Chooses the slides worth showing under the current filters.
 *
 * Survey slides follow only the audience filter, since the questionnaires are
 * anonymous and cannot be narrowed by church or ticket. The churches,
 * ages and sales slides are decided on the unfiltered data so they stay,
 * highlighting the selection.
 *
 * @param data - The report data.
 * @param filters - The active filters.
 * @returns Slide ids in presentation order.
 */
export const deckOutline = (data: ReportData, filters: Filters): SlideId[] => {
  const rows = applyFilters(data.attendees, filters);
  const roles = activeRoles(filters);
  const participants = roles.includes('participant');
  const participantSurvey =
    filters.audience !== 'volunteer' ? data.surveys.participant : null;
  const volunteerSurvey =
    filters.audience !== 'participant' ? data.surveys.volunteer : null;
  const ratings = participantSurvey ? ratingStats(participantSurvey) : [];
  const grouped = groupRatings(ratings);

  const shown: Record<SlideId, boolean> = {
    cover: true,
    attendance: participants && ticketSummary(rows).tickets > 0,
    sales:
      participants &&
      data.attendees.some(
        (a) => a.role === 'participant' && !a.archived && a.saleDate !== null,
      ),
    checkin: rows.some(
      (a) => !a.archived && a.checkedIn && a.checkinAt !== null,
    ),
    redemptions: redeemedItems(rows).length > 0,
    redemptionTimeline: redeemedItems(rows).length > 0,
    churches:
      participants &&
      data.attendees.some(
        (a) => a.role === 'participant' && !a.archived && a.church !== null,
      ),
    ages:
      participants &&
      data.attendees.some(
        (a) => a.role === 'participant' && !a.archived && ageBandOf(a) !== null,
      ),
    participantScore: ratings.some((r) => r.id === OVERALL && r.n > 0),
    ranking: grouped.attractions.length > 0,
    structure: grouped.structure.length > 0,
    yesNo:
      participantSurvey !== null &&
      yesNoStats(participantSurvey).some((q) => q.n > 0),
    volunteers:
      (roles.includes('volunteer') && volunteerSummary(rows).total > 0) ||
      (volunteerSurvey?.responses.length ?? 0) > 0,
    areas: volunteerSurvey !== null && byArea(volunteerSurvey).areas.length > 0,
    resumo: data.resumoHtml !== null,
    closing: true,
  };

  return SLIDE_IDS.filter((id) => shown[id]);
};

/**
 * Finds the day of the event from the first check-in.
 *
 * @param attendees - Every row of the export.
 * @returns Epoch milliseconds of the earliest participant check-in, else of any
 * role's, or `null` when nobody checked in.
 */
export const eventDay = (attendees: readonly Attendee[]): number | null => {
  const earliest = (role?: Attendee['role']): number | null => {
    const times = attendees.flatMap((a) =>
      !a.archived &&
      a.checkinAt !== null &&
      (role === undefined || a.role === role)
        ? [a.checkinAt]
        : [],
    );

    return times.length > 0 ? Math.min(...times) : null;
  };

  return earliest('participant') ?? earliest();
};

/**
 * Keeps the first `n` churches and sums the rest into one
 * {@link OTHER_CHURCHES} row. A church actually named "Outras" is not treated
 * specially, so it may appear alongside the aggregate.
 *
 * @param rows - Churches, largest first.
 * @param n - How many to keep as they are.
 */
export const topChurches = (rows: ChurchRow[], n = 8): ChurchRow[] => {
  const rest = rows.slice(n);

  if (rest.length === 0) return rows;
  const sum = (key: 'tickets' | 'checkedIn' | 'absent'): number =>
    rest.reduce((total, row) => total + row[key], 0);
  const tickets = sum('tickets');
  const absent = sum('absent');

  return [
    ...rows.slice(0, n),
    {
      church: OTHER_CHURCHES,
      tickets,
      checkedIn: sum('checkedIn'),
      absent,
      noShowRate: tickets === 0 ? null : absent / tickets,
    },
  ];
};

const AUDIENCE_LABELS = {
  participant: 'Participantes',
  volunteer: 'Voluntários',
} as const;

const TICKET_LABELS = {
  preSale: 'Ingressos antecipados',
  walkIn: 'Comprados no dia',
} as const;

/** Most church names listed before the summary counts them instead. */
const LISTED = 2;

/** Describes the church exclusions; `null` when they are the default. */
const churchPart = (
  filters: Filters,
  churches: readonly string[] | undefined,
): string | null => {
  if (isChurchFilterDefault(filters)) return null;
  const excluded = new Set(filters.excludedChurches.map(churchKey));
  const included = churches?.filter((n) => !excluded.has(churchKey(n))) ?? [];

  if (included.length > 0 && included.length <= LISTED) {
    return `Igrejas: ${included.join(', ')}`;
  }
  const names = filters.excludedChurches;

  if (names.length === 0) return null;

  return names.length <= LISTED
    ? `Igrejas: todas exceto ${names.join(', ')}`
    : `Igrejas: todas exceto ${String(names.length)}`;
};

/**
 * Describes the active filters for a slide footer. The default church
 * exclusions (the staff) are left out.
 *
 * @param filters - The active filters.
 * @param churches - Every church name in the data, `UNKNOWN_CHURCH`
 * included when present; lets the summary list the few churches kept.
 * @returns Text such as "Filtros: Participantes · Igrejas: Igreja Exemplo A", or
 * `null` when nothing is filtered.
 */
export const filterSummary = (
  filters: Filters,
  churches?: readonly string[],
): string | null => {
  const ageText = ageLabel(filters.age);
  const parts = [
    filters.audience === 'all' ? null : AUDIENCE_LABELS[filters.audience],
    churchPart(filters, churches),
    ageText === null ? null : `Idade: ${ageText}`,
    filters.ticket === 'all' ? null : TICKET_LABELS[filters.ticket],
  ].filter((part) => part !== null);

  return parts.length > 0 ? `Filtros: ${parts.join(' · ')}` : null;
};
