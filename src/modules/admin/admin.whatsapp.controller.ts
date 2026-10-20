import type { AdminRefusal } from '../../types/admin-refusal.ts';
import type { Request, RequestHandler } from 'express';

import { AdminWhatsappService } from './admin.whatsapp.service.ts';

import { isAudienceRole } from '../../constants/audience.ts';
import {
  isWhatsappTemplateKey,
  type WhatsappTemplateKey,
} from '../../constants/whatsapp-templates.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';
import { readStringField } from '../../shared/utils/request-body.ts';
import { isUuid } from '../../shared/utils/uuid.ts';

import type { AttendeeRole } from '../../types/attendee.ts';

/**
 * The WhatsApp sender's endpoints.
 *
 * Validation is by hand with the guards the rest of the admin surface uses, and
 * each refusal carries a `reason` naming what it refused, as the service's do.
 */

/**
 * Reads the template a request names.
 *
 * @param body - Parsed request body, or whatever Express left in its place.
 * @throws {ValidationError} If it is absent or not a registered template.
 */
const readTemplateKey = (body: unknown): WhatsappTemplateKey => {
  const value = readStringField(body, 'templateKey');

  if (value === undefined || !isWhatsappTemplateKey(value)) {
    throw new ValidationError('Invalid template', {
      reason: 'templateInvalid',
    });
  }

  return value;
};

/**
 * Reads the audience a request names.
 *
 * @param body - Parsed request body, or whatever Express left in its place.
 * @throws {ValidationError} If it is neither role.
 */
const readRole = (body: unknown): AttendeeRole => {
  const value = readStringField(body, 'role');

  if (!isAudienceRole(value)) {
    throw new ValidationError('Invalid audience', {
      reason: 'audienceInvalid',
    });
  }

  return value;
};

/**
 * Reads a required, non-empty string field.
 *
 * @param body - Parsed request body, or whatever Express left in its place.
 * @param field - Field to read.
 * @param reason - Refusal when it is missing.
 * @throws {ValidationError} If it is absent or empty.
 */
const readRequired = (
  body: unknown,
  field: string,
  reason: AdminRefusal,
): string => {
  const value = readStringField(body, field);

  if (!value) throw new ValidationError(`Missing ${field}`, { reason });

  return value;
};

/**
 * Reads and checks the run this request names.
 *
 * A `ValidationError` rather than a `NotFoundError`, for the reason
 * `readAttendeeId` in `admin.attendees.controller.ts` gives: "not an ID" and "no
 * run has this ID" stay separable in a log line.
 *
 * @param req - Request carrying the route parameter.
 * @throws {ValidationError} If the parameter is absent, repeated, or not a UUID.
 */
const readRunId = (req: Request): string => {
  const runId = req.params.runId;

  if (!isUuid(runId)) {
    throw new ValidationError('Invalid run ID', { reason: 'runInvalid' });
  }

  return runId;
};

/** Counts who a run would reach, and issues the token that confirms it. */
export const preview: RequestHandler = async (req, res, next) => {
  try {
    const service = new AdminWhatsappService(req);

    res.json({
      success: true,
      code: 'WHATSAPP_PREVIEW',
      data: await service.preview(
        readTemplateKey(req.body),
        readRole(req.body),
      ),
    });
  } catch (err) {
    next(err);
  }
};

/** Starts the run a preview described. */
export const startRun: RequestHandler = async (req, res, next) => {
  try {
    const templateKey = readTemplateKey(req.body);
    const role = readRole(req.body);
    const previewToken = readRequired(
      req.body,
      'previewToken',
      'previewMissing',
    );

    const service = new AdminWhatsappService(req);

    res.json({
      success: true,
      code: 'WHATSAPP_RUN_STARTED',
      data: await service.startRun(templateKey, role, previewToken),
    });
  } catch (err) {
    next(err);
  }
};

/** Pauses a running run. */
export const stopRun: RequestHandler = async (req, res, next) => {
  try {
    const runId = readRunId(req);

    const service = new AdminWhatsappService(req);

    res.json({
      success: true,
      code: 'WHATSAPP_RUN_STOPPED',
      data: await service.stopRun(runId),
    });
  } catch (err) {
    next(err);
  }
};

/** Resumes a paused run. */
export const resumeRun: RequestHandler = async (req, res, next) => {
  try {
    const runId = readRunId(req);

    const service = new AdminWhatsappService(req);

    res.json({
      success: true,
      code: 'WHATSAPP_RUN_RESUMED',
      data: await service.resumeRun(runId),
    });
  } catch (err) {
    next(err);
  }
};

/** Re-queues the rows a restart or a failed tick left interrupted. */
export const retryInterrupted: RequestHandler = async (req, res, next) => {
  try {
    const runId = readRunId(req);

    const service = new AdminWhatsappService(req);

    res.json({
      success: true,
      code: 'WHATSAPP_INTERRUPTED_REQUEUED',
      data: await service.retryInterrupted(runId),
    });
  } catch (err) {
    next(err);
  }
};

/** Abandons a run so it stops blocking the event. */
export const cancelRun: RequestHandler = async (req, res, next) => {
  try {
    const runId = readRunId(req);

    const service = new AdminWhatsappService(req);

    res.json({
      success: true,
      code: 'WHATSAPP_RUN_CANCELLED',
      data: await service.cancelRun(runId),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Sends one template to a typed number, with placeholder values.
 *
 * `POST` with the number in the body, never a query string: `mask.ts` records a
 * form that reached the network as a `GET` and wrote its fields into the request
 * log. `req.body.phone` is redacted as the backstop.
 */
export const testSend: RequestHandler = async (req, res, next) => {
  try {
    const templateKey = readTemplateKey(req.body);
    const phone = readRequired(req.body, 'phone', 'phoneMissing');

    const service = new AdminWhatsappService(req);

    res.json({
      success: true,
      code: 'WHATSAPP_TEST_SENT',
      data: await service.testSend(templateKey, phone),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * The sender screen's progress poll.
 *
 * Mounted on its own in `api/index.ts`, above `/admin`, so it charges
 * `whatsappPollLimiter` rather than the admin budget. `data` is `null` when the
 * event has no run yet.
 */
export const currentRun: RequestHandler = async (req, res, next) => {
  try {
    const service = new AdminWhatsappService(req);

    res.json({
      success: true,
      code: 'WHATSAPP_RUN_CURRENT',
      data: await service.currentRun(),
    });
  } catch (err) {
    next(err);
  }
};
