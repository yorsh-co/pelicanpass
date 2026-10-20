import type { Request } from 'express';

import { buildSurveyCsv } from './survey.csv.ts';
import { surveyFor } from './survey.definition.ts';
import {
  countResponses,
  readExportRows,
  readOverride,
} from './survey.repository.ts';
import { resolveSurveyState, setOverride } from './survey.window.ts';

import { env } from '../../config/env.ts';
import { recordEvent } from '../../shared/telemetry/record.ts';

import type { AttendeeRole } from '../../types/attendee.ts';
import type { AdminSession } from '../../types/session.ts';
import type {
  SurveyAudienceOverview,
  SurveyOverride,
  SurveyOverview,
  SurveyState,
} from '../../types/survey.ts';

const AUDIENCES: readonly AttendeeRole[] = ['participant', 'volunteer'];

/**
 * The questionnaire's state, switches, schedule and counts.
 *
 * The override is read fresh rather than through the window's cache, so the
 * control shows what is stored even in the seconds after another instance
 * changed it.
 *
 * Standalone so a reader with no request, such as the metrics snapshot, can ask
 * without constructing the service.
 *
 * @returns The overview.
 */
export const readSurveyOverview = async (): Promise<SurveyOverview> => {
  const [state, override, counts] = await Promise.all([
    resolveSurveyState(),
    readOverride(),
    countResponses(),
  ]);

  const audience = (role: AttendeeRole): SurveyAudienceOverview => ({
    enabled: env.survey.enabled[role],
    hasQuestions: surveyFor(role) !== null,
    responses: counts[role],
  });

  return {
    state,
    override,
    opensAt: env.survey.opensAt,
    closesAt: env.survey.closesAt,
    audiences: {
      participant: audience('participant'),
      volunteer: audience('volunteer'),
    },
  };
};

/** The questionnaire, as an administrator oversees it. */
export class SurveyAdminService {
  readonly req: Request;

  /**
   * @param req - Request carrying an already-gated admin session.
   */
  constructor(req: Request) {
    this.req = req;
  }

  /** The administrator an override is recorded against. */
  get adminId(): string | undefined {
    const session = this.req.session as AdminSession | undefined;

    return session?.adminId ?? undefined;
  }

  /**
   * The questionnaire's state, switches, schedule and counts.
   *
   * @see readSurveyOverview
   */
  overview(): Promise<SurveyOverview> {
    return readSurveyOverview();
  }

  /**
   * One audience's responses as CSV.
   *
   * Built against that audience's pt-BR questions, whether or not its switch is
   * on: answers already collected are exported after a form is switched off.
   * An audience with no file gets no question columns, and every answer lands
   * in `other_answers`.
   *
   * @param audience - Whose responses.
   */
  async exportCsv(audience: AttendeeRole): Promise<string> {
    const rows = await readExportRows(audience);

    return buildSurveyCsv(rows, surveyFor(audience)?.questions ?? []);
  }

  /**
   * Forces the questionnaire open or closed for both audiences, or hands it
   * back to the schedule, and records who did.
   *
   * The event names the administrator and the choice, and nothing about any
   * attendee: it is who changed the window, not who answered.
   *
   * @param override - `open`, `closed`, or `null` for the schedule.
   * @returns The state the questionnaire now resolves to.
   * @throws {Error} If the session carries no admin. The route gate makes that
   *   impossible, so it is a 500 rather than a refusal.
   */
  async setOverride(override: SurveyOverride | null): Promise<SurveyState> {
    const adminId = this.adminId;

    if (!adminId) throw new Error('Admin session carries no adminId');

    await setOverride(override, adminId);

    recordEvent({
      severity: 'info',
      kind: 'domain',
      code: 'SURVEY_OVERRIDE_SET',
      message: 'Questionnaire override set',
      actorType: 'admin',
      actorId: adminId,
      fields: { override: override ?? 'automatic' },
    });

    return resolveSurveyState();
  }
}

/**
 * Narrows an unchecked value to an audience.
 *
 * @param value - A query or body field as received.
 */
export const isAudience = (value: unknown): value is AttendeeRole =>
  typeof value === 'string' && (AUDIENCES as readonly string[]).includes(value);
