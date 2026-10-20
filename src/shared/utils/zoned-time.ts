/**
 * Wall-clock times in a named time zone, as a `datetime-local` input holds
 * them, and the instants they stand for.
 *
 * The administrator's browser may sit in any zone, and the container clock is
 * UTC. An operator scheduling "18:00" means 18:00 at the venue, so the server
 * reads every wall time in the event's zone rather than trusting either clock.
 */

/** `YYYY-MM-DDTHH:mm`, as `datetime-local` submits it by default. */
const WALL_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** The same with `:ss`, as it submits it once a step below a minute is set. */
const WALL_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

const HOUR_MS = 3_600_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A formatter that prints every field of an instant in a zone, numerically.
 * Built once per zone: construction is the expensive part of `Intl`.
 *
 * @param timeZone - IANA zone name.
 */
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    formatters.set(timeZone, formatter);
  }

  return formatter;
};

/**
 * The wall-clock fields of an instant in a zone.
 *
 * @param instant - Epoch milliseconds.
 * @param timeZone - IANA zone name.
 */
const fieldsAt = (instant: number, timeZone: string) => {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
};

/**
 * How far a zone's wall clock is ahead of UTC at an instant.
 *
 * @param instant - Epoch milliseconds.
 * @param timeZone - IANA zone name.
 * @returns The offset in milliseconds; negative west of Greenwich.
 */
const offsetAt = (instant: number, timeZone: string): number => {
  const f = fieldsAt(instant, timeZone);
  const wall = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);

  return wall - Math.floor(instant / 1000) * 1000;
};

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Prints an instant as a zone's wall-clock time, in the form a
 * `datetime-local` input takes as its value.
 *
 * Seconds are printed only when present, so a schedule written to the minute
 * reads back exactly as it was typed.
 *
 * @param instant - Epoch milliseconds.
 * @param timeZone - IANA zone name.
 * @returns `YYYY-MM-DDTHH:mm`, or `YYYY-MM-DDTHH:mm:ss`.
 */
export const instantToWallTime = (
  instant: number,
  timeZone: string,
): string => {
  const f = fieldsAt(instant, timeZone);
  const minute = `${String(f.year)}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}`;

  return f.second === 0 ? minute : `${minute}:${pad(f.second)}`;
};

/**
 * Reads a wall-clock time in a zone as the one instant it names.
 *
 * Tries the zone's offset either side of the wall time and keeps each
 * candidate that prints back to the same wall time. None means the time
 * falls in a daylight-saving gap and never happens; two means it falls in an
 * overlap and happens twice. Both are refused rather than guessed, since a
 * schedule an hour off is worse than one the operator has to retype.
 *
 * @param wall - `YYYY-MM-DDTHH:mm` or `YYYY-MM-DDTHH:mm:ss`.
 * @param timeZone - IANA zone name.
 * @returns Epoch milliseconds, or `null` if the value is malformed, names a
 *   date that does not exist, or is missing or doubled in the zone.
 */
export const wallTimeToInstant = (
  wall: string,
  timeZone: string,
): number | null => {
  if (!WALL_MINUTE.test(wall) && !WALL_SECOND.test(wall)) return null;

  const year = Number(wall.slice(0, 4));
  const month = Number(wall.slice(5, 7));
  const day = Number(wall.slice(8, 10));
  const hour = Number(wall.slice(11, 13));
  const minute = Number(wall.slice(14, 16));
  const second = wall.length === 19 ? Number(wall.slice(17, 19)) : 0;

  const naive = Date.UTC(year, month - 1, day, hour, minute, second);

  // Date.UTC rolls 2026-02-30 over to March; a wall time must name itself.
  const check = new Date(naive);

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }

  const target = instantToWallTime(naive, 'UTC');

  const candidates = new Set(
    [naive - 12 * HOUR_MS, naive + 12 * HOUR_MS].map(
      (probe) => naive - offsetAt(probe, timeZone),
    ),
  );

  const matches = [...candidates].filter(
    (instant) => instantToWallTime(instant, timeZone) === target,
  );

  const [only, ...others] = matches;

  return only !== undefined && others.length === 0 ? only : null;
};
