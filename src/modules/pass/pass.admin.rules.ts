import { firstOutOfOrder } from '../../config/pass-welcome.ts';
import {
  WELCOME_CUSTOM_PHASE,
  WELCOME_SCHEDULE_MAX_ENTRIES,
  WELCOME_TEXT_MAX_LENGTH,
  isWelcomeLinePhase,
  normaliseWelcomeText,
} from '../../constants/pass.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';
import { wallTimeToInstant } from '../../shared/utils/zoned-time.ts';

import type { WelcomeScheduleEntry } from '../../config/pass-welcome.ts';

/** A welcome schedule save, as read off the request. */
export interface WelcomeScheduleSave {
  /** Entries in ascending order, or `null` to hand back to `.env`. */
  schedule: WelcomeScheduleEntry[] | null;

  /** The revision the page was rendered from; `0` for none saved. */
  revision: number;
}

/**
 * Reads a welcome schedule save from a request body.
 *
 * Each entry's `at` is a wall-clock time in the event's zone, as the editor's
 * `datetime-local` input holds it, so the schedule means the venue's clock
 * whichever zone the administrator's device is in.
 *
 * A `custom` entry carries its own `text`, stored in normalised form. A `text`
 * on any other phase is dropped: the built-in phases read theirs from
 * `pass.welcome`.
 *
 * Entries are sorted here rather than required in order: the editor lists rows
 * as they were added, and ordering them is not the operator's job. What
 * sorting cannot fix — two entries at one instant — is refused.
 *
 * `schedule: null` is a choice — hand back to `.env` — so it must be sent, not
 * implied: a body that failed to parse leaves the field absent, and reading
 * that as a reset would turn a malformed request into an instruction.
 *
 * @param body - Parsed request body, or whatever Express left in its place.
 * @param timeZone - The event's IANA zone.
 * @throws {ValidationError} With the refusal's `reason`, if the body is not a
 *   save, an entry names an unknown phase or a time that does not exist in the
 *   zone, a custom line is empty or too long, two entries share an instant, or
 *   there are too many.
 */
export const readWelcomeScheduleSave = (
  body: unknown,
  timeZone: string,
): WelcomeScheduleSave => {
  const fields =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};

  const { revision, schedule } = fields;

  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    (schedule !== null && !Array.isArray(schedule))
  ) {
    throw new ValidationError('Invalid welcome schedule save', {
      reason: 'scheduleInvalid',
    });
  }

  if (schedule === null) return { schedule: null, revision };

  const items = schedule as unknown[];

  if (items.length > WELCOME_SCHEDULE_MAX_ENTRIES) {
    throw new ValidationError('Too many welcome schedule entries', {
      reason: 'scheduleTooLong',
    });
  }

  const entries = items.map((item): WelcomeScheduleEntry => {
    const { phase, at, text } =
      typeof item === 'object' && item !== null
        ? (item as Record<string, unknown>)
        : {};

    if (
      !isWelcomeLinePhase(phase) ||
      typeof at !== 'string' ||
      (phase === WELCOME_CUSTOM_PHASE && typeof text !== 'string')
    ) {
      throw new ValidationError('Invalid welcome schedule entry', {
        reason: 'scheduleInvalid',
      });
    }

    const instant = wallTimeToInstant(at, timeZone);

    if (instant === null) {
      throw new ValidationError('Invalid welcome schedule time', {
        reason: 'scheduleTimeInvalid',
      });
    }

    if (phase !== WELCOME_CUSTOM_PHASE) return { phase, at: instant };

    const line = normaliseWelcomeText(text as string);

    if (line === '') {
      throw new ValidationError('Empty custom welcome text', {
        reason: 'scheduleTextMissing',
      });
    }

    if (Array.from(line).length > WELCOME_TEXT_MAX_LENGTH) {
      throw new ValidationError('Custom welcome text too long', {
        reason: 'scheduleTextTooLong',
      });
    }

    return { phase, text: line, at: instant };
  });

  entries.sort((a, b) => a.at - b.at);

  if (firstOutOfOrder(entries) !== -1) {
    throw new ValidationError('Two welcome schedule entries share a time', {
      reason: 'scheduleDuplicateTime',
    });
  }

  return { schedule: entries, revision };
};
