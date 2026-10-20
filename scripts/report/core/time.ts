/** The zone the event ran in; slots and clock times are read in it. */
export const EVENT_TIME_ZONE = 'America/Sao_Paulo';

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }

  return formatter;
};

/**
 * The zone's offset from UTC at an instant, in milliseconds.
 *
 * @param epochMs - The instant.
 * @param timeZone - An IANA zone name.
 */
const offsetAt = (epochMs: number, timeZone: string): number => {
  const whole = Math.floor(epochMs / 1000) * 1000;
  const parts: Record<string, number> = {};

  for (const { type, value } of formatterFor(timeZone).formatToParts(whole)) {
    parts[type] = Number(value);
  }
  const wall = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );

  return wall - whole;
};

/**
 * Start of the wall-clock slot containing an instant, e.g. 14:00 for a
 * 15-minute slot at 14:07 local time. The zone's real offset is used, so
 * slots stay aligned to local time whatever the offset is.
 *
 * @param epochMs - The instant.
 * @param minutes - Slot length; must divide a day for slots to line up.
 * @param timeZone - An IANA zone name.
 * @returns The slot's start, in epoch milliseconds.
 */
export const slotStart = (
  epochMs: number,
  minutes: number,
  timeZone: string = EVENT_TIME_ZONE,
): number => {
  const slot = minutes * 60_000;
  const offset = offsetAt(epochMs, timeZone);

  return Math.floor((epochMs + offset) / slot) * slot - offset;
};

/**
 * Formats an instant as `HH:mm` in the given zone.
 *
 * @param epochMs - The instant.
 * @param timeZone - An IANA zone name.
 */
export const formatTime = (
  epochMs: number,
  timeZone: string = EVENT_TIME_ZONE,
): string => {
  const local = new Date(epochMs + offsetAt(epochMs, timeZone));
  const pad = (n: number): string => String(n).padStart(2, '0');

  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
};

/**
 * Formats a span as whole minutes in pt-BR: `12 min`, `1 h 25 min`, `2 h`.
 *
 * @param ms - The span, rounded to the nearest minute.
 */
export const formatDuration = (ms: number): string => {
  const total = Math.round(ms / 60_000);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;

  if (hours === 0) return `${String(minutes)} min`;
  if (minutes === 0) return `${String(hours)} h`;

  return `${String(hours)} h ${String(minutes)} min`;
};
