import { eventDay } from './deck.ts';
import { EVENT_TIME_ZONE } from './time.ts';

import type { Attendee } from './checkin.ts';

/** One period of the sales chart, with inclusive `YYYY-MM-DD` bounds. */
export interface SaleBucket {
  id: string;
  label: string;
  /** First day of the period; `null` when it has no start. */
  from: string | null;
  /** Last day of the period. */
  to: string | null;
}

/** Tickets sold in one {@link SaleBucket}. */
export interface SaleRow extends SaleBucket {
  tickets: number;
}

/** Tickets without a sale date. */
export interface NoSaleDateRow {
  id: 'none';
  label: string;
  tickets: number;
}

const DAY_MS = 86_400_000;
/** Days in the last week before the event day, shown as one period. */
const LAST_WEEK = 7;
/** Weekly periods before the last week. */
const WEEKLY = 3;

const pad = (n: number): string => String(n).padStart(2, '0');

const parse = (date: string): number =>
  Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );

const format = (ms: number): string => {
  const d = new Date(ms);

  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** Moves a date by whole days. */
const addDays = (date: string, days: number): string =>
  format(parse(date) + days * DAY_MS);

/** Moves a date back by calendar months, clamping the day to the month. */
const monthsBefore = (date: string, months: number): string => {
  const index = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
  const target = index - months;
  const year = Math.floor(target / 12);
  const month = target % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return format(
    Date.UTC(year, month, Math.min(Number(date.slice(8, 10)), last)),
  );
};

/**
 * Splits the run-up to the event into periods that get finer as the day
 * nears: months, then weeks, then the event day. Together they cover every
 * date up to the event day without gaps. Labels count down to the event, like
 * `2–3 semanas` or `0–1 semana`; the exact dates are in `from` and `to`.
 *
 * @param eventDate - The event day, `YYYY-MM-DD`.
 * @returns Periods, oldest first.
 */
export const saleBuckets = (eventDate: string): SaleBucket[] => {
  const weeksStart = addDays(eventDate, -(LAST_WEEK + 7 * WEEKLY));
  const six = monthsBefore(eventDate, 6);
  const three = monthsBefore(eventDate, 3);
  const two = monthsBefore(eventDate, 2);
  const monthly: SaleBucket[] = [
    {
      id: 'months-6-plus',
      label: '+6 meses',
      from: null,
      to: addDays(six, -1),
    },
    {
      id: 'months-3-6',
      label: '3–6 meses',
      from: six,
      to: addDays(three, -1),
    },
    {
      id: 'months-2-3',
      label: '2–3 meses',
      from: three,
      to: addDays(two, -1),
    },
    {
      id: 'months-1-2',
      label: '1–2 meses',
      from: two,
      to: addDays(weeksStart, -1),
    },
  ];
  const weekly = Array.from({ length: WEEKLY }, (_, i): SaleBucket => {
    const from = addDays(weeksStart, 7 * i);
    const to = addDays(from, 6);
    const weeks = WEEKLY - i;

    return {
      id: `week-${String(weeks)}`,
      label: `${String(weeks)}–${String(weeks + 1)} semanas`,
      from,
      to,
    };
  });
  const lastWeek: SaleBucket = {
    id: 'week-0',
    label: '0–1 semana',
    from: addDays(eventDate, -LAST_WEEK),
    to: addDays(eventDate, -1),
  };

  return [
    ...monthly,
    ...weekly,
    lastWeek,
    {
      id: 'event',
      label: 'Dia do evento',
      from: eventDate,
      to: eventDate,
    },
  ];
};

/** The calendar date of an instant in the event's zone. */
const localDate = (epochMs: number): string => {
  const parts: Record<string, string> = {};
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: EVENT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  for (const { type, value } of formatter.formatToParts(epochMs)) {
    parts[type] = value;
  }

  return `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}`;
};

/**
 * Finds the day the sales chart counts back from: the day of the first
 * check-in, else the last participant sale date.
 *
 * @param attendees - Every row of the export.
 * @returns `YYYY-MM-DD`, or `null` when there is neither.
 */
export const salesEventDate = (
  attendees: readonly Attendee[],
): string | null => {
  const checkin = eventDay(attendees);

  if (checkin !== null) return localDate(checkin);
  const dates = attendees.flatMap((a) =>
    a.role === 'participant' && !a.archived && a.saleDate !== null
      ? [a.saleDate]
      : [],
  );

  return dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : null;
};

/**
 * Counts the participant tickets sold in each period. Sales dated after the
 * event day count on the event day.
 *
 * @param attendees - Every row of the export.
 * @param eventDate - The event day, `YYYY-MM-DD`.
 * @returns Every period, oldest first, empty ones included, then a "Sem data"
 * row when some tickets have no date; `[]` when none has a date.
 */
export const salesByBucket = (
  attendees: readonly Attendee[],
  eventDate: string,
): (SaleRow | NoSaleDateRow)[] => {
  const tickets = attendees.filter(
    (a) => a.role === 'participant' && !a.archived,
  );

  if (!tickets.some((a) => a.saleDate !== null)) return [];
  const rows: SaleRow[] = saleBuckets(eventDate).map((b) => ({
    ...b,
    tickets: 0,
  }));
  let undated = 0;

  for (const { saleDate } of tickets) {
    if (saleDate === null) {
      undated++;
      continue;
    }
    const day = saleDate > eventDate ? eventDate : saleDate;
    const row = rows.find(
      (r) =>
        (r.from === null || day >= r.from) && (r.to === null || day <= r.to),
    );

    if (row) row.tickets++;
  }

  return undated > 0
    ? [...rows, { id: 'none', label: 'Sem data', tickets: undated }]
    : rows;
};
