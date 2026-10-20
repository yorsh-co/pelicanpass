import type { RedemptionItem } from '../../constants/pass.ts';
import type { AdminRefusal } from '../../types/admin-refusal.ts';
import type { AppErrorCode } from '../../types/appErrorCode.ts';
import type { CheckinStep } from '../../types/checkin.ts';

/**
 * Machine-readable context attached to an {@link AppError}.
 *
 * This object is serialised into the error response and read by the browser,
 * so it is part of the public API surface. Every member is optional and owned
 * by exactly one subclass; the constructors below are where the shape is
 * actually enforced, which keeps the read sites free of narrowing.
 */
export interface AppErrorDetails {
  /** {@link RateLimitError}: seconds the caller must wait before retrying. */
  retryAfterSeconds?: number | undefined;

  /** {@link CaptchaRequiredError}: step to resume at once the captcha clears. */
  nextStep?: CheckinStep | undefined;

  /** {@link CaptchaRequiredError}: whether the client must render a captcha. */
  captchaRequired?: boolean | undefined;

  /**
   * Admin refusals: which one, since a single code covers several. The admin
   * client names it from the `admin-errors` catalog.
   */
  reason?: AdminRefusal | undefined;

  /** Admin refusals: the item a refusal is about, where it names one. */
  item?: RedemptionItem | undefined;
}

/** Constructor options for {@link AppError}. */
export interface AppErrorOptions {
  statusCode?: number | undefined;
  code?: AppErrorCode | undefined;
  details?: AppErrorDetails | undefined;
}

/**
 * Base class for operational errors — expected failures from bad input,
 * missing resources, auth, conflicts, etc. — as opposed to programming
 * errors (bugs, unhandled exceptions), which are NOT instances of this
 * class and are always reported to the client as a generic 500.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: AppErrorCode;
  readonly details: AppErrorDetails | undefined;
  readonly isOperational = true;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);

    this.name = this.constructor.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.details = options.details;

    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details?: AppErrorDetails) {
    super(message, { statusCode: 400, code: 'VALIDATION_ERROR', details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details?: AppErrorDetails) {
    super(message, { statusCode: 404, code: 'NOT_FOUND', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, { statusCode: 401, code: 'UNAUTHORIZED' });
  }
}

/**
 * The request was understood and identified, and is still refused.
 *
 * Distinct from {@link UnauthorizedError}: 401 means "authenticate and try
 * again", 403 means retrying will not help. Raised by `requireSameOrigin` for a
 * cross-site request, where the caller's credentials are perfectly valid and
 * the request is still not one they made.
 */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, { statusCode: 403, code: 'FORBIDDEN' });
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'Unsupported media type') {
    super(message, { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request body too large') {
    super(message, { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details?: AppErrorDetails) {
    super(message, { statusCode: 409, code: 'CONFLICT', details });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', retryAfterSeconds?: number) {
    super(message, {
      statusCode: 429,
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds },
    });
  }
}

/**
 * Built by the load-shedding middleware to describe a request turned away while
 * the process is overloaded.
 *
 * Handed straight to `renderErrorPage` rather than thrown: the error handlers
 * log every 5xx at `error` and record an event row for it, which is work the
 * shed exists to avoid.
 */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Server busy', retryAfterSeconds?: number) {
    super(message, {
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { retryAfterSeconds },
    });
  }
}

/**
 * A dependency the request needs, such as Redis, is unreachable.
 *
 * Thrown, unlike its parent, and answered `503` with `Retry-After` by the
 * error handlers, which log it at `warn`: the outage is already reported once
 * by the dependency's own probe, and an `error` line per request would repeat
 * it for every attendee at the door. It still counts as `http.5xx`, because
 * unlike a shed it is a failure and the 5xx alert should hear it.
 */
export class DependencyUnavailableError extends ServiceUnavailableError {
  constructor(
    message = 'Service temporarily unavailable',
    retryAfterSeconds?: number,
  ) {
    super(message, retryAfterSeconds);
  }
}

/**
 * Raised when a valid credential is presented before that audience's check-in
 * window has opened.
 *
 * Deliberately not a `ForbiddenError`: it is the only 403 the check-in flow can
 * raise, and the browser has to tell it apart from a bad code to say "not yet"
 * rather than "wrong". Callers must also keep it clear of the failure budgets —
 * see the guarded rethrows in `checkin.service.ts`.
 */
export class CheckinNotOpenError extends AppError {
  constructor(message = 'Check-in is not open yet') {
    super(message, { statusCode: 403, code: 'CHECKIN_NOT_OPEN' });
  }
}

/**
 * Answers a verified attendee whose check-in staff have not confirmed yet.
 *
 * An expected outcome rather than a fault: the browser branches on the code to
 * keep the attendee on the QR step. It is `409` because the request is valid
 * and the conflict is with the attendee's current state, which may change.
 */
export class NotMarkedPresentError extends AppError {
  constructor(message = 'Attendee not marked present') {
    super(message, { statusCode: 409, code: 'NOT_MARKED_PRESENT' });
  }
}

/**
 * Raised by every attendee-facing endpoint once `EVENT_CLOSES_AT` has passed.
 *
 * `410 Gone` because the refusal is permanent. The browser's request helper
 * reloads the page on this code, and the reload lands on the closing page, so
 * a pass left open in a pocket ends up there on its next poll.
 */
export class EventClosedError extends AppError {
  constructor(message = 'The event has closed') {
    super(message, { statusCode: 410, code: 'EVENT_CLOSED' });
  }
}

/**
 * Raised when an answer arrives while the questionnaire's window is shut.
 *
 * Its own code rather than a `ForbiddenError`, for the same reason as
 * {@link CheckinNotOpenError}: the card has to tell "closed for now" apart from
 * "not for your audience", which is the plain `FORBIDDEN`.
 */
export class SurveyClosedError extends AppError {
  constructor(message = 'The questionnaire is closed') {
    super(message, { statusCode: 403, code: 'SURVEY_CLOSED' });
  }
}

/**
 * Raised when an attendee who has already answered submits again, from any
 * device or session.
 *
 * Its own code rather than a bare `ConflictError`, because the card treats it
 * as success already recorded and shows its done state, where
 * {@link SurveyStaleError} makes it reload.
 */
export class SurveyAnsweredError extends AppError {
  constructor(message = 'The questionnaire was already answered') {
    super(message, { statusCode: 409, code: 'SURVEY_ANSWERED' });
  }
}

/**
 * Raised when a form was built from questions that have since changed shape:
 * an id, type, required flag or max-length differs from what is deployed now.
 *
 * The card reloads to show the current questions, rather than submitting
 * answers to ones that no longer exist.
 */
export class SurveyStaleError extends AppError {
  constructor(message = 'The questionnaire has changed') {
    super(message, { statusCode: 409, code: 'SURVEY_STALE' });
  }
}

export class CaptchaRequiredError extends AppError {
  constructor(
    message = 'Captcha verification required',
    details?: Pick<AppErrorDetails, 'nextStep' | 'captchaRequired'>,
  ) {
    super(message, { statusCode: 400, code: 'CAPTCHA_REQUIRED', details });
  }
}
