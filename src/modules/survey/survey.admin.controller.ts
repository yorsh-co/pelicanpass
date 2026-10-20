import type { RequestHandler } from 'express';

import { SurveyAdminService } from './survey.admin.ts';

import { ValidationError } from '../../shared/errors/app-error.ts';

import type { SurveyOverride } from '../../types/survey.ts';

/**
 * Reads the override from a body.
 *
 * `null` is a choice — hand back to the schedule — so it must be sent, not
 * implied: a body that failed to parse leaves the field absent, and reading
 * that as "automatic" would turn a malformed request into an instruction.
 *
 * @param body - Parsed request body, or whatever Express left in its place.
 * @throws {ValidationError} If `override` is absent or not one of the three.
 */
const readOverride = (body: unknown): SurveyOverride | null => {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).override
      : undefined;

  if (value === null || value === 'open' || value === 'closed') return value;

  throw new ValidationError('Invalid override');
};

/** Forces the questionnaire open or closed, or hands it back to the schedule. */
export const setOverride: RequestHandler = async (req, res, next) => {
  try {
    const override = readOverride(req.body);

    const service = new SurveyAdminService(req);

    res.json({
      success: true,
      code: 'SURVEY_OVERRIDE_SET',
      data: await service.setOverride(override),
    });
  } catch (err) {
    next(err);
  }
};
