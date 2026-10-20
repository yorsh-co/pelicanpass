import type { Request, Response } from 'express';

import { surveyFor } from './survey.definition.ts';
import { recordSubmission } from './survey.repository.ts';
import { resolveSurveyState, surveyAudienceEnabled } from './survey.window.ts';

import {
  ForbiddenError,
  NotFoundError,
  SurveyAnsweredError,
  SurveyClosedError,
  SurveyStaleError,
  UnauthorizedError,
  ValidationError,
} from '../../shared/errors/app-error.ts';

import type { AttendeeSession } from '../../types/session.ts';
import type {
  SurveyAnswers,
  SurveyDefinition,
  SurveyQuestion,
} from '../../types/survey.ts';

const RATING_MIN = 1;
const RATING_MAX = 10;

/**
 * One question's answer, cleaned, or `undefined` when it was left blank.
 *
 * @param question - The question answered.
 * @param value - What the request carried for it.
 * @throws {ValidationError} If the value has the wrong shape for the question.
 */
const cleanAnswer = (
  question: SurveyQuestion,
  value: unknown,
): number | boolean | string | undefined => {
  if (value === undefined || value === null) return undefined;

  switch (question.type) {
    case 'rating':
      if (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= RATING_MIN &&
        value <= RATING_MAX
      ) {
        return value;
      }
      break;
    case 'yes-no':
      if (typeof value === 'boolean') return value;
      break;
    case 'text': {
      if (typeof value !== 'string') break;

      const trimmed = value.trim();

      // Refused rather than cut: the textarea's `maxlength` stops a real
      // browser, so an over-long value was built by hand.
      if (trimmed.length > question.maxLength) break;

      return trimmed === '' ? undefined : trimmed;
    }
  }

  throw new ValidationError('Invalid answers');
};

/**
 * Checks a submission's answers against one audience's questions.
 *
 * Pure. Every refusal is the same message, which names no question and no
 * value: it reaches the error body and the logs.
 *
 * @param definition - The questions the answers must fit.
 * @param raw - `answers` as the request carried it.
 * @returns The answers to store, blank ones left out.
 * @throws {ValidationError} If `raw` is not a plain object, names a question
 *   the definition lacks, gives a value of the wrong shape, or leaves a
 *   required question unanswered.
 */
export const validateAnswers = (
  definition: SurveyDefinition,
  raw: unknown,
): SurveyAnswers => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('Invalid answers');
  }

  const given = raw as Record<string, unknown>;
  const known = new Set(definition.questions.map((question) => question.id));

  if (Object.keys(given).some((id) => !known.has(id))) {
    throw new ValidationError('Invalid answers');
  }

  const answers: SurveyAnswers = {};

  for (const question of definition.questions) {
    const answer = cleanAnswer(question, given[question.id]);

    if (answer === undefined) {
      if (question.required) throw new ValidationError('Invalid answers');

      continue;
    }

    answers[question.id] = answer;
  }

  return answers;
};

/** Request and response the service acts on. */
interface SurveyServiceParams {
  req: Request;
  res: Response;
}

/** What the card sends. */
export interface SurveySubmission {
  structureVersion: string;
  answers: unknown;
}

/** The questionnaire, as a signed-in attendee answers it. */
export class SurveyService {
  readonly session: AttendeeSession;

  /**
   * @param params - Request and response for the current call.
   * @throws {Error} If the request carries no attendee session. The route
   *   sits behind `requireSessionType('attendee')`, so this reports a wiring
   *   mistake rather than an unauthenticated caller.
   */
  constructor({ req }: SurveyServiceParams) {
    const { session } = req;

    if (session?.type !== 'attendee') {
      throw new Error(
        'SurveyService requires an attendee session on the request',
      );
    }

    this.session = session;
  }

  /**
   * Records the attendee's answers, once.
   *
   * The checks run in the order `docs/features/survey.md` § Who can answer, and how
   * often sets out. The window is checked before the transaction, since it
   * needs no row. The role, and with it the questions, the version and the
   * audience stored, is read from Postgres inside it: the session's
   * `attendeeRole` is never consulted.
   *
   * @param submission - The form's structure version and its answers.
   * @throws {UnauthorizedError} If the session names no attendee.
   * @throws {SurveyClosedError} If the window is shut.
   * @throws {NotFoundError} If the attendee is archived, not checked in, or
   *   gone.
   * @throws {ForbiddenError} If the attendee's audience is switched off.
   * @throws {SurveyStaleError} If the form was built from other questions.
   * @throws {ValidationError} If the answers do not fit the questions.
   * @throws {SurveyAnsweredError} If the attendee already answered.
   */
  async submit({ structureVersion, answers }: SurveySubmission): Promise<void> {
    const { attendeeId } = this.session;

    if (!attendeeId) throw new UnauthorizedError();

    if (!(await resolveSurveyState()).open) throw new SurveyClosedError();

    const outcome = await recordSubmission(attendeeId, (role) => {
      const definition = surveyFor(role);

      if (!surveyAudienceEnabled(role) || definition === null) {
        throw new ForbiddenError('No questionnaire for this audience');
      }

      if (structureVersion !== definition.structureVersion) {
        throw new SurveyStaleError();
      }

      return {
        audience: role,
        version: definition.version,
        answers: validateAnswers(definition, answers),
      };
    });

    if (outcome === 'not-found') {
      throw new NotFoundError('Attendee profile not found');
    }

    if (outcome === 'answered') throw new SurveyAnsweredError();
  }
}
