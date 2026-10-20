import { env } from '../../config/env.ts';
import { decodeStoredSchedule } from '../../config/pass-welcome.ts';
import { recordEvent } from '../../shared/telemetry/record.ts';
import {
  readWelcomeState,
  writeWelcomeState,
} from './pass.welcome.repository.ts';

import type { WelcomeScheduleEntry } from '../../config/pass-welcome.ts';
import type { StoredWelcomeState } from './pass.welcome.repository.ts';

/**
 * Which welcome schedule the pass follows: the one an administrator saved at
 * `/admin/pass`, or else `PASS_WELCOME_SCHEDULE`.
 *
 * One module rather than a read in each caller, for the reason
 * `survey.window.ts` gives: the pass render and both pass polls apply one
 * rule, and copies of it would drift.
 */

/** Where the schedule in force came from. */
export type WelcomeScheduleSource = 'env' | 'admin';

/** The schedule in force. */
export interface ResolvedWelcomeSchedule {
  entries: readonly WelcomeScheduleEntry[];
  source: WelcomeScheduleSource;
}

/**
 * Picks the schedule in force from the event's row.
 *
 * @param state - The row, or `null` before the first save.
 * @param fallback - `PASS_WELCOME_SCHEDULE`, as parsed at boot.
 * @returns The saved schedule when there is a valid one, `.env`'s otherwise.
 *   An empty saved list is a choice — `arrival` throughout — and wins.
 */
export const pickWelcomeSchedule = (
  state: StoredWelcomeState | null,
  fallback: readonly WelcomeScheduleEntry[],
): ResolvedWelcomeSchedule => {
  if (state === null || state.schedule === null) {
    return { entries: fallback, source: 'env' };
  }

  const entries = decodeStoredSchedule(state.schedule);

  if (entries === null) {
    recordEvent({
      severity: 'error',
      kind: 'domain',
      code: 'PASS_WELCOME_SCHEDULE_INVALID',
      message: 'Stored welcome schedule is invalid; following .env',
      fields: { revision: state.revision },
    });

    return { entries: fallback, source: 'env' };
  }

  return { entries, source: 'admin' };
};

/**
 * How long a read is reused.
 *
 * Every pass render and pass poll resolves the schedule, and none may cost a
 * query per attendee. Five seconds is the longest another instance follows a
 * stale schedule after an administrator saves, well inside the poll's thirty.
 */
const CACHE_MS = 5_000;

let cached: { at: number; state: Promise<StoredWelcomeState | null> } | null =
  null;

/**
 * The event's row, read at most once per {@link CACHE_MS}.
 *
 * The promise is cached rather than the value, so concurrent callers share one
 * query instead of each starting their own.
 */
const cachedState = (): Promise<StoredWelcomeState | null> => {
  const now = Date.now();

  if (cached && now - cached.at < CACHE_MS) return cached.state;

  const state = readWelcomeState();

  cached = { at: now, state };

  // A failed read must not be served for the rest of the window.
  state.catch(() => {
    cached = null;
  });

  return state;
};

/** The schedule every pass follows right now. */
export const resolveWelcomeSchedule =
  async (): Promise<ResolvedWelcomeSchedule> =>
    pickWelcomeSchedule(await cachedState(), env.passWelcomeSchedule);

/**
 * Saves a schedule, or hands back to `.env`, and drops this instance's cached
 * read so the administrator sees the change at once. Any other instance
 * catches up within {@link CACHE_MS}.
 *
 * @param schedule - Entries in ascending order, or `null` for `.env`.
 * @param adminId - `admins.admin_id` of the administrator saving.
 * @param expectedRevision - The revision the save was made against.
 * @returns The new revision, or `null` if someone else saved first.
 */
export const saveWelcomeSchedule = async (
  schedule: readonly WelcomeScheduleEntry[] | null,
  adminId: string,
  expectedRevision: number,
): Promise<number | null> => {
  const revision = await writeWelcomeState(schedule, adminId, expectedRevision);

  cached = null;

  return revision;
};
