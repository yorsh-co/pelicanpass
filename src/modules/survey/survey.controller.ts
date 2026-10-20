import type { RequestHandler } from 'express';

import { SurveyService } from './survey.service.ts';

import { ValidationError } from '../../shared/errors/app-error.ts';
import { readStringField } from '../../shared/utils/request-body.ts';

/**
 * Records the attendee's answers.
 *
 * `answers` is passed on unread: its shape is the service's to judge against
 * the attendee's questions, and only the service knows which those are.
 */
export const submit: RequestHandler = async (req, res, next) => {
  try {
    const structureVersion = readStringField(req.body, 'structureVersion');

    if (structureVersion === undefined) {
      throw new ValidationError('Invalid answers');
    }

    const service = new SurveyService({ req, res });

    await service.submit({
      structureVersion,
      answers: (req.body as Record<string, unknown>).answers,
    });

    res.setHeader('Cache-Control', 'no-store');

    res.status(201).json({ success: true, code: 'SURVEY_RECORDED' });
  } catch (err) {
    next(err);
  }
};
