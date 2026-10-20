/**
 * Stable error codes carried by `AppError` and its subclasses. These are
 * serialised into error responses, so treat them as public API surface.
 */
export type AppErrorCode =
  | 'INTERNAL_ERROR'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'CAPTCHA_REQUIRED'
  | 'CHECKIN_NOT_OPEN'
  | 'NOT_MARKED_PRESENT'
  | 'SURVEY_CLOSED'
  | 'SURVEY_ANSWERED'
  | 'SURVEY_STALE'
  | 'EVENT_CLOSED'
  | 'SERVICE_UNAVAILABLE';
