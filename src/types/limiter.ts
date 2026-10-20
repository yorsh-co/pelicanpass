import type { SessionType } from './session.ts';

/**
 * What one rate-limiter bucket is keyed on, as a code the metrics panel names
 * from `admin-metrics.limiter.keyedOn.*`.
 */
export type LimiterKeyBasis =
  | 'ip'
  | 'ipStrict'
  | 'ipTrusted'
  | `${SessionType}Session`
  | 'checkinCookie'
  | 'volunteerSession'
  | 'global'
  | 'adminUsername'
  | 'verifiedAttendee'
  | 'lookupVolunteer'
  | 'admin';

/**
 * What a rate limiter protects, and what a refusal there means, as a code the
 * metrics panel names from `admin-metrics.limiter.protects.*`.
 */
export type LimiterPurpose =
  | 'api'
  | 'web'
  | `${SessionType}SessionRoutes`
  | 'checkinCreation'
  | 'staffCounters'
  | 'metricsPanel'
  | 'redemptionsPanel'
  | 'whatsappSender'
  | 'clientErrorsIp'
  | 'clientErrorsGlobal'
  | 'whatsappWebhookIp'
  | 'whatsappWebhookGlobal'
  | 'adminLogin'
  | 'adminLoginFailures'
  | 'checkinEntry'
  | 'checkinEntryFailures'
  | 'verificationFailures'
  | 'lookupFailures'
  | 'whatsappDoor';
