import {
  WELCOME_CUSTOM_PHASE,
  WELCOME_TEXT_MAX_LENGTH,
  isWelcomePhase,
  normaliseWelcomeText,
} from '../constants/pass.ts';
import { parseInstant } from './read-env.ts';

import type { WelcomePhase } from '../constants/pass.ts';

/**
 * What the welcome line says: a built-in phase, whose text is the
 * `pass.welcome` case of that name, or a line an administrator wrote.
 */
export type WelcomeLine =
  | { phase: WelcomePhase }
  | { phase: typeof WELCOME_CUSTOM_PHASE; text: string };

/** One switch of the welcome line: from `at`, the pass shows that line. */
export type WelcomeScheduleEntry = WelcomeLine & {
  /** Epoch milliseconds. */
  at: number;
};

/**
 * Parses the welcome schedule, as in
 * `default@2026-10-03T13:00:00-03:00,survey@2026-10-03T18:00:00-03:00`.
 *
 * A list rather than a variable per phase, so a phase can come back — the
 * arrival text again on the second morning. Entries must be strictly
 * ascending: `.env` is edited under time pressure on the day, and a swapped
 * pair would otherwise show a phase for no time at all rather than fail the
 * boot.
 *
 * @param key - Name of the environment variable, for the error messages.
 * @param value - The variable's value, or undefined when unset or empty.
 * @returns The entries, in order. Empty when unset.
 * @throws {Error} If an entry is malformed, names an unknown phase, carries an
 *   instant without an offset, or is not after the one before it.
 */
export const parseWelcomeSchedule = (
  key: string,
  value: string | undefined,
): WelcomeScheduleEntry[] => {
  if (value === undefined || value.trim() === '') return [];

  const entries = value.split(',').map((raw): WelcomeScheduleEntry => {
    const entry = raw.trim();
    const sep = entry.indexOf('@');

    if (sep === -1) {
      throw new Error(
        `Environment variable ${key} entries must read "phase@instant", received "${entry}"`,
      );
    }

    const phase = entry.slice(0, sep);

    if (!isWelcomePhase(phase)) {
      throw new Error(
        `Environment variable ${key} names an unknown phase "${phase}"`,
      );
    }

    return { phase, at: parseInstant(key, entry.slice(sep + 1)) };
  });

  const i = firstOutOfOrder(entries);
  const entry = entries[i];
  const previous = entries[i - 1];

  if (entry && previous) {
    throw new Error(
      `Environment variable ${key} must list its entries in ascending order: "${entry.phase}" at ${new Date(entry.at).toISOString()} is not after "${previous.phase}" at ${new Date(previous.at).toISOString()}`,
    );
  }

  return entries;
};

/**
 * Finds the first entry that does not start strictly after the one before it.
 *
 * The one ordering rule, shared by the `.env` parser and the administrator's
 * editor, so a schedule one accepts the other cannot refuse.
 *
 * @param entries - Entries in the order given.
 * @returns The offending entry's index, or -1 when the list is in order.
 */
export const firstOutOfOrder = (
  entries: readonly WelcomeScheduleEntry[],
): number =>
  entries.findIndex((entry, i) => {
    const previous = entries[i - 1];

    return previous !== undefined && entry.at <= previous.at;
  });

/**
 * Reports whether a custom line may be stored and shown: already in its
 * normalised form, not empty, and within {@link WELCOME_TEXT_MAX_LENGTH} code
 * points.
 *
 * @param text - The line, as normalised by `normaliseWelcomeText`.
 */
export const isValidWelcomeText = (text: string): boolean =>
  text !== '' &&
  normaliseWelcomeText(text) === text &&
  Array.from(text).length <= WELCOME_TEXT_MAX_LENGTH;

/**
 * Reads a stored schedule back into entries, checking it as the editor did.
 *
 * Only this application writes the column, through the same checks, so a
 * refusal here means a hand edit or a bug. It is treated as no schedule at all
 * rather than thrown: a bad row must not take every pass down with it.
 *
 * @param stored - The `schedule` column as read.
 * @returns The entries, or `null` if the value is not a valid schedule.
 */
export const decodeStoredSchedule = (
  stored: unknown,
): WelcomeScheduleEntry[] | null => {
  if (!Array.isArray(stored)) return null;

  const entries: WelcomeScheduleEntry[] = [];

  for (const item of stored as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;

    const { phase, at, text } = item as Record<string, unknown>;

    if (typeof at !== 'string') return null;

    const instant = Date.parse(at);

    if (Number.isNaN(instant)) return null;

    if (phase === WELCOME_CUSTOM_PHASE) {
      if (typeof text !== 'string' || !isValidWelcomeText(text)) return null;

      entries.push({ phase, text, at: instant });
    } else if (isWelcomePhase(phase)) {
      entries.push({ phase, at: instant });
    } else {
      return null;
    }
  }

  return firstOutOfOrder(entries) === -1 ? entries : null;
};

/**
 * Picks the welcome line in force at an instant.
 *
 * @param schedule - Entries in ascending order, as parsed.
 * @param now - The instant, in epoch milliseconds.
 * @returns The line of the last entry at or before `now`, or `arrival` before
 *   the first.
 */
export const welcomeLineAt = (
  schedule: readonly WelcomeScheduleEntry[],
  now: number,
): WelcomeLine => {
  let line: WelcomeLine = { phase: 'arrival' };

  for (const entry of schedule) {
    if (entry.at > now) break;

    line = entry;
  }

  return line.phase === WELCOME_CUSTOM_PHASE
    ? { phase: line.phase, text: line.text }
    : { phase: line.phase };
};

/**
 * Settles a scheduled line against one attendee's questionnaire.
 *
 * The `survey` line points down at the feedback button, so it gives way once
 * that button is not on their pass: to `thanks` once they have answered, and
 * to `default` while the questionnaire is not open to them. Every other line,
 * a custom one included, is the schedule's to decide.
 *
 * @param line - The scheduled line, from {@link welcomeLineAt}.
 * @param survey - Whether the questionnaire is open to the attendee, and
 *   whether they have answered it.
 * @returns The line their pass shows.
 */
export const welcomePhaseFor = (
  line: WelcomeLine,
  survey: { open: boolean; completed: boolean },
): WelcomeLine => {
  if (line.phase !== 'survey') return line;
  if (survey.completed) return { phase: 'thanks' };

  return { phase: survey.open ? 'survey' : 'default' };
};
