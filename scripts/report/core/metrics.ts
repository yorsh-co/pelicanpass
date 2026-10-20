import { AGE_DETAILS, UNKNOWN_AGE, bandOfDetail } from './age.ts';
import { matchAreas } from './areas.ts';
import { ITEM_KEYS } from './checkin.ts';
import { followUpParents } from './survey.ts';
import { slotStart } from './time.ts';

import type { AgeBand, AgeDetail } from './age.ts';
import type { Attendee, ItemKey } from './checkin.ts';
import type { SurveyData, SurveyResponse } from './survey.ts';

type Role = Attendee['role'];

const ROLES: readonly Role[] = ['participant', 'volunteer'];

/** Label for attendees whose church is blank. */
export const UNKNOWN_CHURCH = 'Não informada';

/** `part / whole`, or `null` when there is no whole. */
const ratio = (part: number, whole: number): number | null =>
  whole === 0 ? null : part / whole;

const mean = (values: readonly number[]): number | null =>
  values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const present = (attendees: readonly Attendee[], role?: Role): Attendee[] =>
  attendees.filter(
    (a) => !a.archived && (role === undefined || a.role === role),
  );

/** Tickets, arrivals and no-shows for a group of participants. */
export interface AttendanceSplit {
  tickets: number;
  checkedIn: number;
  absent: number;
  /** `absent / tickets`; `null` without tickets. */
  noShowRate: number | null;
}

const split = (group: readonly Attendee[]): AttendanceSplit => {
  const checkedIn = group.filter((a) => a.checkedIn).length;
  const absent = group.length - checkedIn;

  return {
    tickets: group.length,
    checkedIn,
    absent,
    noShowRate: ratio(absent, group.length),
  };
};

/** Participant attendance, overall and by how the ticket was bought. */
export interface TicketSummary extends AttendanceSplit {
  /** Tickets bought on event day; `null` if any ticket's origin is unknown. */
  walkIns: number | null;
  /** `null` when ticket origin is unknown. */
  preSale: AttendanceSplit | null;
  /** `null` when ticket origin is unknown. */
  walkIn: AttendanceSplit | null;
  /** Archived registrations of either role, excluded from everything else. */
  archived: number;
}

/**
 * Summarises participant attendance. Archived registrations are only counted.
 *
 * @param attendees - Every row of the export.
 */
export const ticketSummary = (
  attendees: readonly Attendee[],
): TicketSummary => {
  const participants = present(attendees, 'participant');
  const known = participants.every((a) => a.walkIn !== null);

  return {
    ...split(participants),
    walkIns: known ? participants.filter((a) => a.walkIn).length : null,
    preSale: known
      ? split(participants.filter((a) => a.walkIn === false))
      : null,
    walkIn: known ? split(participants.filter((a) => a.walkIn === true)) : null,
    archived: attendees.filter((a) => a.archived).length,
  };
};

/** Volunteer attendance. */
export interface VolunteerSummary {
  total: number;
  checkedIn: number;
  /** `checkedIn / total`; `null` without volunteers. */
  rate: number | null;
}

/**
 * Summarises volunteer attendance, leaving out archived registrations.
 *
 * @param attendees - Every row of the export.
 */
export const volunteerSummary = (
  attendees: readonly Attendee[],
): VolunteerSummary => {
  const volunteers = present(attendees, 'volunteer');
  const checkedIn = volunteers.filter((a) => a.checkedIn).length;

  return {
    total: volunteers.length,
    checkedIn,
    rate: ratio(checkedIn, volunteers.length),
  };
};

/** Events in one time slot, by role. */
export interface Slot {
  /** Slot start, epoch milliseconds. */
  start: number;
  participant: number;
  volunteer: number;
  total: number;
}

/** Counts events per slot from the first to the last, zero-filled between. */
const slots = (
  events: readonly { at: number; role: Role }[],
  slotMinutes: number,
): Slot[] => {
  if (events.length === 0) return [];
  const counts = new Map<number, Record<Role, number>>();

  for (const { at, role } of events) {
    const start = slotStart(at, slotMinutes);
    const entry = counts.get(start) ?? { participant: 0, volunteer: 0 };

    entry[role]++;
    counts.set(start, entry);
  }
  const starts = [...counts.keys()];
  const first = Math.min(...starts);
  const last = Math.max(...starts);
  const result: Slot[] = [];

  for (let start = first; start <= last; start += slotMinutes * 60_000) {
    const { participant, volunteer } = counts.get(start) ?? {
      participant: 0,
      volunteer: 0,
    };

    result.push({
      start,
      participant,
      volunteer,
      total: participant + volunteer,
    });
  }

  return result;
};

/** A slot with the running total up to and including it. */
export interface CumulativeSlot extends Slot {
  cumulative: number;
}

/** Adds the running total to each slot of a series. */
const accumulate = (series: Slot[]): CumulativeSlot[] => {
  let cumulative = 0;

  return series.map((slot) => {
    cumulative += slot.total;

    return { ...slot, cumulative };
  });
};

/**
 * Check-ins per slot, by role, with a running total. Only non-archived
 * attendees with a check-in time count.
 *
 * @param attendees - Every row of the export.
 * @param slotMinutes - Slot length.
 */
export const checkinSeries = (
  attendees: readonly Attendee[],
  slotMinutes: number,
): CumulativeSlot[] => {
  const events = present(attendees).flatMap((a) =>
    a.checkedIn && a.checkinAt !== null
      ? [{ at: a.checkinAt, role: a.role }]
      : [],
  );

  return accumulate(slots(events, slotMinutes));
};

/** Landmarks of the arrival curve; all `null` without check-ins. */
export interface Milestones {
  peak: { start: number; count: number } | null;
  /** Instant the 50% of eventual check-ins had arrived. */
  half: number | null;
  /** Instant 90% of eventual check-ins had arrived. */
  ninety: number | null;
}

/**
 * Finds the busiest slot (the earliest on a tie) and when half and 90% of the
 * eventual check-ins had arrived.
 *
 * @param attendees - Every row of the export.
 * @param slotMinutes - Slot length for the peak.
 */
export const checkinMilestones = (
  attendees: readonly Attendee[],
  slotMinutes: number,
): Milestones => {
  const series = checkinSeries(attendees, slotMinutes);
  const times = present(attendees)
    .flatMap((a) => (a.checkedIn && a.checkinAt !== null ? [a.checkinAt] : []))
    .sort((a, b) => a - b);
  const reached = (share: number): number | null =>
    times[Math.ceil(share * times.length) - 1] ?? null;
  let peak: Milestones['peak'] = null;

  for (const { start, total } of series) {
    if (peak === null || total > peak.count) peak = { start, count: total };
  }

  return { peak, half: reached(0.5), ninety: reached(0.9) };
};

/** Participant attendance for one age detail group. */
export type AgeDetailRow = AttendanceSplit & {
  detail: AgeDetail | typeof UNKNOWN_AGE;
  /** The filter range the group belongs to; `null` for unknown. */
  band: AgeBand | null;
};

/**
 * Participant attendance per age detail group, using the same population as
 * {@link byChurch}. Every group appears in order, empty ones included, so the
 * axis is continuous; an {@link UNKNOWN_AGE} row follows only when some
 * participant has no age.
 *
 * @param attendees - Every row of the export.
 * @returns No rows when no participant has an age.
 */
export const byAgeDetail = (attendees: readonly Attendee[]): AgeDetailRow[] => {
  const participants = present(attendees, 'participant');

  if (participants.every((a) => a.ageDetail === null)) return [];
  const rows: AgeDetailRow[] = AGE_DETAILS.map((detail) => ({
    detail,
    band: bandOfDetail(detail),
    ...split(participants.filter((a) => a.ageDetail === detail)),
  }));
  const unknown = participants.filter((a) => a.ageDetail === null);

  return unknown.length > 0
    ? [...rows, { detail: UNKNOWN_AGE, band: null, ...split(unknown) }]
    : rows;
};

/** Participant attendance for one church. */
export interface ChurchRow extends AttendanceSplit {
  church: string;
}

/**
 * Participant attendance per church, largest first. Blank churches are
 * grouped as {@link UNKNOWN_CHURCH}.
 *
 * @param attendees - Every row of the export.
 */
export const byChurch = (attendees: readonly Attendee[]): ChurchRow[] => {
  const groups = new Map<string, Attendee[]>();

  for (const a of present(attendees, 'participant')) {
    const key = a.church ?? UNKNOWN_CHURCH;

    const group = groups.get(key);

    if (group) group.push(a);
    else groups.set(key, [a]);
  }

  return [...groups]
    .map(([church, group]) => ({ church, ...split(group) }))
    .sort(
      (a, b) =>
        b.tickets - a.tickets || a.church.localeCompare(b.church, 'pt-BR'),
    );
};

/**
 * Lowercases, trims and collapses whitespace, so hand-typed church names
 * compare equal.
 *
 * @param name - A church name as typed or displayed.
 */
export const churchKey = (name: string): string =>
  name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Host church attendance against everyone else's. */
export interface HostChurchSplit {
  host: AttendanceSplit;
  /** Every participant from a named church other than the host. */
  others: AttendanceSplit;
  /** Participants with no church. */
  unknown: number;
}

/**
 * Compares the host church (matched ignoring case and extra whitespace)
 * with all other churches. Uses the same population
 * as {@link byChurch}. Callers should pass attendees already filtered by
 * audience, ticket and church, so excluded churches (the staff, by default)
 * fall out of "Outras igrejas".
 *
 * @param attendees - Every row of the export.
 * @param hostChurch - The church that hosts the event, as written in the
 *   `church` column; `null` when none is configured.
 * @returns `null` when there is no host church or no participant belongs to it.
 */
export const hostChurchSplit = (
  attendees: readonly Attendee[],
  hostChurch: string | null,
): HostChurchSplit | null => {
  if (hostChurch === null) return null;
  const host: Attendee[] = [];
  const others: Attendee[] = [];
  let unknown = 0;

  for (const a of present(attendees, 'participant')) {
    if (a.church === null) unknown++;
    else if (churchKey(a.church) === churchKey(hostChurch)) {
      host.push(a);
    } else others.push(a);
  }

  return host.length === 0
    ? null
    : { host: split(host), others: split(others), unknown };
};

/** Redemption of one item by one role. */
export interface ItemRow {
  item: ItemKey;
  role: Role;
  /** Attendees with an option for the item. */
  entitled: number;
  redeemed: number;
  /** `redeemed / entitled`. */
  rate: number | null;
  first: number | null;
  last: number | null;
  /** `last - first`, in milliseconds. */
  windowMs: number | null;
}

/**
 * Summarises redemption per item and role, omitting combinations nobody was
 * entitled to. Archived attendees are left out.
 *
 * @param attendees - Every row of the export.
 */
export const itemSummary = (attendees: readonly Attendee[]): ItemRow[] =>
  ITEM_KEYS.flatMap((item) =>
    ROLES.flatMap((role): ItemRow[] => {
      const group = present(attendees, role).map((a) => a.items[item]);
      const entitledItems = group.filter((s) => s.option !== null);
      const entitled = entitledItems.length;
      const times = entitledItems.flatMap((s) =>
        s.redeemedAt === null ? [] : [s.redeemedAt],
      );
      const first = times.length > 0 ? Math.min(...times) : null;
      const last = times.length > 0 ? Math.max(...times) : null;

      if (entitled === 0) return [];

      return [
        {
          item,
          role,
          entitled,
          redeemed: times.length,
          rate: ratio(times.length, entitled),
          first,
          last,
          windowMs: first === null || last === null ? null : last - first,
        },
      ];
    }),
  );

/**
 * {@link itemSummary} without the items nobody collected.
 *
 * @param attendees - Every row of the export.
 */
export const redeemedItems = (attendees: readonly Attendee[]): ItemRow[] =>
  itemSummary(attendees).filter((row) => row.redeemed > 0);

/**
 * Redemptions of an item per slot, by role, with a running total.
 *
 * @param attendees - Every row of the export.
 * @param item - The item.
 * @param slotMinutes - Slot length.
 */
export const redemptionSeries = (
  attendees: readonly Attendee[],
  item: ItemKey,
  slotMinutes: number,
): CumulativeSlot[] =>
  accumulate(
    slots(
      present(attendees).flatMap((a) => {
        const at = a.items[item].redeemedAt;

        return at === null ? [] : [{ at, role: a.role }];
      }),
      slotMinutes,
    ),
  );

/** One option of an item and how many took it. */
export interface OptionRow {
  option: string;
  ordered: number;
  redeemed: number;
}

/**
 * Counts an item's options, most ordered first.
 *
 * @param attendees - Every row of the export.
 * @param item - The item.
 */
export const optionBreakdown = (
  attendees: readonly Attendee[],
  item: ItemKey,
): OptionRow[] => {
  const rows = new Map<string, OptionRow>();

  for (const { option, redeemedAt } of present(attendees).map(
    (a) => a.items[item],
  )) {
    if (option === null) continue;
    const row = rows.get(option) ?? { option, ordered: 0, redeemed: 0 };

    row.ordered++;
    if (redeemedAt !== null) row.redeemed++;
    rows.set(option, row);
  }

  return [...rows.values()].sort(
    (a, b) =>
      b.ordered - a.ordered || a.option.localeCompare(b.option, 'pt-BR'),
  );
};

/**
 * Share of check-ins that answered the survey.
 *
 * @param responses - The audience's responses.
 * @param checkedInCount - People of that audience who checked in.
 * @returns `null` when nobody checked in.
 */
export const responseRate = (
  responses: readonly SurveyResponse[],
  checkedInCount: number,
): number | null => ratio(responses.length, checkedInCount);

/** Statistics for one rating question. */
export interface RatingStat {
  id: string;
  label: string;
  n: number;
  mean: number | null;
  /** Position `i` holds how many gave a score of `i + 1`. */
  distribution: number[];
}

const numbersFor = (survey: SurveyData, id: string): number[] =>
  survey.responses.flatMap((r) => {
    const value = r.answers[id];

    return typeof value === 'number' ? [value] : [];
  });

/**
 * Statistics for every rating question.
 *
 * @param survey - A parsed survey.
 */
export const ratingStats = (survey: SurveyData): RatingStat[] =>
  survey.questions
    .filter((q) => q.type === 'rating')
    .map(({ id, label }) => {
      const values = numbersFor(survey, id);
      const distribution = Array.from({ length: 10 }, () => 0);

      for (const value of values) {
        distribution[value - 1] = (distribution[value - 1] ?? 0) + 1;
      }

      return { id, label, n: values.length, mean: mean(values), distribution };
    });

/**
 * Orders rating statistics best first; questions without answers go last.
 *
 * @param stats - Output of {@link ratingStats}.
 */
export const rankByMean = (stats: readonly RatingStat[]): RatingStat[] =>
  [...stats].sort((a, b) => (b.mean ?? -1) - (a.mean ?? -1));

/** A count and its share of all scores. */
export interface Band {
  count: number;
  /** `null` without scores. */
  share: number | null;
}

/** Scores split into 9–10, 7–8 and 6 or below. */
export interface ScoreBands {
  n: number;
  high: Band;
  mid: Band;
  low: Band;
}

/**
 * Splits 1–10 scores into bands.
 *
 * @param values - The scores.
 */
export const scoreBands = (values: readonly number[]): ScoreBands => {
  const band = (count: number): Band => ({
    count,
    share: ratio(count, values.length),
  });

  return {
    n: values.length,
    high: band(values.filter((v) => v >= 9).length),
    mid: band(values.filter((v) => v >= 7 && v < 9).length),
    low: band(values.filter((v) => v < 7).length),
  };
};

/** Statistics for one yes-no question. */
export interface YesNoStat {
  id: string;
  label: string;
  n: number;
  yes: number;
  no: number;
  yesShare: number | null;
}

/**
 * Statistics for every yes-no question.
 *
 * @param survey - A parsed survey.
 */
export const yesNoStats = (survey: SurveyData): YesNoStat[] =>
  survey.questions
    .filter((q) => q.type === 'yes-no')
    .map(({ id, label }) => {
      const values = survey.responses.flatMap((r) => {
        const value = r.answers[id];

        return typeof value === 'boolean' ? [value] : [];
      });
      const yes = values.filter(Boolean).length;

      return {
        id,
        label,
        n: values.length,
        yes,
        no: values.length - yes,
        yesShare: ratio(yes, values.length),
      };
    });

/** The written answers to one text question. */
export interface TextAnswers {
  id: string;
  label: string;
  answers: string[];
}

/**
 * Collects the non-empty answers to every text question.
 *
 * @param survey - A parsed survey.
 */
export const textAnswers = (survey: SurveyData): TextAnswers[] =>
  survey.questions
    .filter((q) => q.type === 'text')
    .map(({ id, label }) => ({
      id,
      label,
      answers: survey.responses.flatMap((r) => {
        const value = r.answers[id];

        return typeof value === 'string' && value.trim() !== '' ? [value] : [];
      }),
    }));

/** One written answer, with the answer it explains when it is a follow-up. */
export interface TextComment {
  questionId: string;
  label: string;
  text: string;
  /** The question this one explains and the same response's answer to it. */
  parent: {
    id: string;
    label: string;
    answer: number | boolean | null;
  } | null;
}

/**
 * Lists the non-empty text answers one by one, in question then response order.
 * A follow-up carries its parent question and the same response's answer to it.
 *
 * @param survey - A parsed survey.
 */
export const textComments = (survey: SurveyData): TextComment[] => {
  const parents = followUpParents(survey.questions);

  return survey.questions
    .filter((q) => q.type === 'text')
    .flatMap(({ id, label }) => {
      const parent = parents.get(id);

      return survey.responses.flatMap((r) => {
        const text = r.answers[id];
        const answer = parent === undefined ? null : r.answers[parent.id];

        if (typeof text !== 'string' || text.trim() === '') return [];

        return [
          {
            questionId: id,
            label,
            text,
            parent:
              parent === undefined
                ? null
                : {
                    id: parent.id,
                    label: parent.label,
                    answer:
                      typeof answer === 'string' ? null : (answer ?? null),
                  },
          },
        ];
      });
    });
};

/** Volunteer ratings for one area. */
export interface AreaRow {
  area: string;
  n: number;
  /** Mean per rating question id; `null` if nobody in the area answered it. */
  means: Record<string, number | null>;
}

/** Per-area results with small groups withheld. */
export interface AreaBreakdown {
  /** Areas with at least `minN` responses, largest first. */
  areas: AreaRow[];
  /** Areas left out for having fewer than `minN` responses. */
  suppressedCount: number;
  /** Distinct raw answers that named no known area. */
  unmatched: string[];
}

/** Question that holds the volunteer's area, as free text. */
const AREA_QUESTION = 'volunteer_area';

/**
 * Averages volunteer ratings per area. A response naming several areas counts
 * in each. Areas below `minN` responses are not returned, so no individual can
 * be singled out.
 *
 * @param survey - The volunteer survey.
 * @param minN - Smallest group that may be shown.
 */
export const byArea = (survey: SurveyData, minN = 5): AreaBreakdown => {
  const result: AreaBreakdown = {
    areas: [],
    suppressedCount: 0,
    unmatched: [],
  };

  if (!survey.questions.some((q) => q.id === AREA_QUESTION)) return result;
  const ratings = survey.questions.filter((q) => q.type === 'rating');
  const groups = new Map<string, SurveyResponse[]>();
  const unmatched = new Set<string>();

  for (const response of survey.responses) {
    const raw = response.answers[AREA_QUESTION];

    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const areas = matchAreas(raw);

    if (areas.length === 0) unmatched.add(raw);
    for (const area of areas) {
      const group = groups.get(area);

      if (group) group.push(response);
      else groups.set(area, [response]);
    }
  }
  result.unmatched = [...unmatched];

  for (const [area, group] of groups) {
    if (group.length < minN) {
      result.suppressedCount++;
      continue;
    }
    result.areas.push({
      area,
      n: group.length,
      means: Object.fromEntries(
        ratings.map(({ id }) => [
          id,
          mean(
            group.flatMap((r) => {
              const value = r.answers[id];

              return typeof value === 'number' ? [value] : [];
            }),
          ),
        ]),
      ),
    });
  }
  result.areas.sort(
    (a, b) => b.n - a.n || a.area.localeCompare(b.area, 'pt-BR'),
  );

  return result;
};
