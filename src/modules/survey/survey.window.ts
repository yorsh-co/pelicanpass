import { env } from '../../config/env.ts';
import { checkinOpensAt } from '../checkin/checkin.window.ts';
import { surveyFor } from './survey.definition.ts';
import { readOverride, writeOverride } from './survey.repository.ts';

import type { AttendeeRole } from '../../types/attendee.ts';
import type { SurveyOverride, SurveyState } from '../../types/survey.ts';

/**
 * Whether the questionnaire is open, for whom, and why.
 *
 * One module rather than a check in each gate: the pass render, the pass
 * poll and the submit are three enforcement points for one rule, and three
 * copies of it would drift. An audience's form is open when its `.env` switch
 * is on, it has a questions file, and the window — shared by both audiences —
 * is open.
 *
 * Two boot checks run as this module loads, because `env.ts` cannot make them:
 * one needs the question files, the other `checkinOpensAt`, which reads `env`.
 */

const AUDIENCES: readonly AttendeeRole[] = ['participant', 'volunteer'];

if (env.survey.enabled.volunteer && surveyFor('volunteer') === null) {
  throw new Error(
    'SURVEY_VOLUNTEER_ENABLED is true, so src/web/content/pt-BR/survey-volunteer.md must exist (or set SURVEY_VOLUNTEER_ENABLED=false)',
  );
}

// The attendee session's TTL slides only when the session is written, and the
// pass poll writes nothing. An attendee who checks in as their doors open and
// then only watches the pass must still hold a session when the survey closes,
// or the form they were promised answers 401. Measured over switched-on
// audiences only, so a drafted volunteer file does not lengthen the rule.
if (env.survey.closesAt !== null) {
  const opens = AUDIENCES.filter((role) => env.survey.enabled[role])
    .map(checkinOpensAt)
    .filter((at) => at !== null);

  if (opens.length > 0) {
    const earliest = Math.min(...opens);
    const ttlMs = env.sessionTtl.attendee * 1000;

    if (env.survey.closesAt - earliest > ttlMs) {
      throw new Error(
        `SURVEY_CLOSES_AT (${new Date(env.survey.closesAt).toISOString()}) is more than ATTENDEE_SESSION_TTL (${String(env.sessionTtl.attendee)}s) after the earliest check-in opening (${new Date(earliest).toISOString()}): raise ATTENDEE_SESSION_TTL or bring SURVEY_CLOSES_AT forward`,
      );
    }
  }
}

/**
 * How long an override read is reused.
 *
 * Every pass render and every pass poll resolves the state, and neither
 * may cost a query per attendee. Five seconds is the longest another instance
 * shows a stale override after an administrator changes it.
 */
const OVERRIDE_CACHE_MS = 5_000;

let cached: { at: number; override: Promise<SurveyOverride | null> } | null =
  null;

/**
 * The event's override, read at most once per {@link OVERRIDE_CACHE_MS}.
 *
 * The promise is cached rather than the value, so concurrent callers share one
 * query instead of each starting their own.
 */
const cachedOverride = (): Promise<SurveyOverride | null> => {
  const now = Date.now();

  if (cached && now - cached.at < OVERRIDE_CACHE_MS) return cached.override;

  const override = readOverride();

  cached = { at: now, override };

  // A failed read must not be served for the rest of the window.
  override.catch(() => {
    cached = null;
  });

  return override;
};

/**
 * Whether the shared window is open.
 *
 * Both switches off is closed, without a query. Otherwise an override wins,
 * and otherwise the schedule decides, open from `SURVEY_OPENS_AT` until
 * `SURVEY_CLOSES_AT`, if set.
 */
export const resolveSurveyState = async (): Promise<SurveyState> => {
  const { enabled, opensAt, closesAt } = env.survey;

  if (!(enabled.participant || enabled.volunteer) || opensAt === null) {
    return { open: false, reason: 'disabled' };
  }

  const override = await cachedOverride();

  if (override !== null) {
    return { open: override === 'open', reason: 'override' };
  }

  const now = Date.now();

  return {
    open: opensAt <= now && (closesAt === null || now < closesAt),
    reason: 'schedule',
  };
};

/**
 * Sets or clears the override, and drops this instance's cached read so the
 * administrator sees the change at once. Any other instance catches up within
 * {@link OVERRIDE_CACHE_MS}.
 *
 * @param override - `open` or `closed`, or `null` to hand back to the schedule.
 * @param adminId - `admins.admin_id` of the administrator acting.
 */
export const setOverride = async (
  override: SurveyOverride | null,
  adminId: string,
): Promise<void> => {
  await writeOverride(override, adminId);

  cached = null;
};

/**
 * Whether an audience is offered the questionnaire at all: its `.env` switch
 * is on and it has a questions file. Says nothing about the window.
 *
 * Separate from {@link isSurveyOpenFor} because the submit refuses the two
 * cases differently: a switched-off audience is `FORBIDDEN`, a closed window
 * `SURVEY_CLOSED`. The pass page also renders a hidden card for an enabled
 * audience, so the pass poll can reveal it when the window opens.
 *
 * @param role - The attendee's role, as recorded in Postgres.
 */
export const surveyAudienceEnabled = (role: AttendeeRole): boolean =>
  env.survey.enabled[role] && surveyFor(role) !== null;

/**
 * Whether an audience may answer right now.
 *
 * The one answer the pass render and the pass poll use; the submit asks
 * the same two questions separately, to refuse each with its own code. The
 * switch and the file are checked first, so an audience that is switched off
 * costs no query.
 *
 * @param role - The attendee's role, as recorded in Postgres.
 */
export const isSurveyOpenFor = async (role: AttendeeRole): Promise<boolean> =>
  surveyAudienceEnabled(role) && (await resolveSurveyState()).open;
