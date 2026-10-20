import { EVENT_TIME_ZONE, formatDuration, formatTime } from '../core/time.ts';

const integer = new Intl.NumberFormat('pt-BR');
const oneDecimal = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const dateTime = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: EVENT_TIME_ZONE,
});
const longDate = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'long',
  timeZone: EVENT_TIME_ZONE,
});

/** Placeholder for a missing value. */
export const DASH = '—';

/** A whole number, or a dash for `null`. */
export const fmtInt = (value: number | null): string =>
  value === null ? DASH : integer.format(value);

/** A mean or other one-decimal figure, or a dash. */
export const fmtDecimal = (value: number | null): string =>
  value === null ? DASH : oneDecimal.format(value);

/** A 0..1 ratio as a percentage with one decimal, or a dash. */
export const fmtPercent = (ratio: number | null): string =>
  ratio === null ? DASH : `${oneDecimal.format(ratio * 100)}%`;

/** An instant as `HH:mm` in the event zone, or a dash. */
export const fmtTime = (ms: number | null): string =>
  ms === null ? DASH : formatTime(ms);

/** A span as pt-BR minutes and hours, or a dash. */
export const fmtDuration = (ms: number | null): string =>
  ms === null ? DASH : formatDuration(ms);

/** A slot as `HH:mm–HH:mm`. */
export const fmtSlot = (start: number, minutes: number): string =>
  `${formatTime(start)}–${formatTime(start + minutes * 60_000)}`;

/** An instant as a long pt-BR date in the event zone, e.g. "9 de agosto de 2026". */
export const fmtLongDate = (ms: number): string =>
  longDate.format(new Date(ms));

/** An ISO timestamp as a pt-BR date and time in the event zone. */
export const fmtDateTime = (iso: string): string =>
  dateTime.format(new Date(iso));

/** `part / whole`, or `null` without a whole. */
export const ratio = (part: number, whole: number): number | null =>
  whole === 0 ? null : part / whole;

/** Lowercases and strips accents, for searching. */
export const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const LEAD =
  /^(o que você achou d[oa]s?|como você avalia|que nota você dá para)\s+/i;

/** A short column header for a long question. */
export const shortLabel = (label: string, max = 18): string => {
  const base = label
    .replace(/\(.*?\)/g, '')
    .replace(LEAD, '')
    .replace(/[?:]\s*$/, '')
    .trim();
  const text = base.charAt(0).toUpperCase() + base.slice(1);

  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
