import { createAdminErrorsMessages } from '../../../../../i18n/generated/admin-errors.messages.ts';
import { readMessages } from '../../../core/i18n.ts';
import { WELCOME_TEXT_MAX_LENGTH } from '../../../../../constants/pass.ts';
import {
  TICKET_LIMIT_CAP_MAX,
  TICKET_LIMIT_CAP_MIN,
} from '../../../../../constants/ticket-limit.ts';

import type { ApiError, ApiErrorDetails } from '../../../core/api/api.error.ts';
import type { AdminRefusal } from '../../../../../types/admin-refusal.ts';

type AdminErrors = ReturnType<typeof createAdminErrorsMessages>;

let cached: AdminErrors | undefined;

/**
 * The `admin-errors` catalog, read on first use rather than at import. A page
 * can import this module and never show a refusal, so its route may inline no
 * catalog; a read at import would throw there and take the page's whole
 * script with it.
 */
const errors = (): AdminErrors =>
  (cached ??= readMessages('admin-errors', createAdminErrorsMessages));

/**
 * Each refusal's message. Total, so a reason added on the server fails the
 * build here until it has words. `undefined` means the details lacked what the
 * message needs, and the caller shows its generic line instead.
 */
const MESSAGES: Record<
  AdminRefusal,
  (details: ApiErrorDetails) => string | undefined
> = {
  attendeeArchived: () => errors().attendeeArchived(),
  attendeeNotFound: () => errors().attendeeNotFound(),
  audienceInvalid: () => errors().audienceInvalid(),
  invalidAttendee: () => errors().invalidAttendee(),
  itemAlreadyRedeemed: ({ item }) =>
    item && errors().itemAlreadyRedeemed({ item }),
  itemNotEntitled: ({ item }) => item && errors().itemNotEntitled({ item }),
  itemNotRedeemed: ({ item }) => item && errors().itemNotRedeemed({ item }),
  listChanged: () => errors().listChanged(),
  nameInvalid: () => errors().nameInvalid(),
  optionNotAllowed: ({ item }) => item && errors().optionNotAllowed({ item }),
  pauseBeforeRetry: () => errors().pauseBeforeRetry(),
  phoneInvalid: () => errors().phoneInvalid(),
  phoneMissing: () => errors().phoneMissing(),
  previewExpired: () => errors().previewExpired(),
  previewMissing: () => errors().previewMissing(),
  reasonInvalid: () => errors().reasonInvalid(),
  redemptionChanged: () => errors().redemptionChanged(),
  requestInProgress: () => errors().requestInProgress(),
  roleInvalid: () => errors().roleInvalid(),
  roleLocked: () => errors().roleLocked(),
  runFinished: () => errors().runFinished(),
  runInProgress: () => errors().runInProgress(),
  runInvalid: () => errors().runInvalid(),
  runNotFound: () => errors().runNotFound(),
  runNotPaused: () => errors().runNotPaused(),
  runNotRunning: () => errors().runNotRunning(),
  scheduleChanged: () => errors().scheduleChanged(),
  scheduleDuplicateTime: () => errors().scheduleDuplicateTime(),
  scheduleInvalid: () => errors().scheduleInvalid(),
  scheduleTextMissing: () => errors().scheduleTextMissing(),
  scheduleTextTooLong: () =>
    errors().scheduleTextTooLong({ max: WELCOME_TEXT_MAX_LENGTH }),
  scheduleTimeInvalid: () => errors().scheduleTimeInvalid(),
  scheduleTooLong: () => errors().scheduleTooLong(),
  sendingDisabled: () => errors().sendingDisabled(),
  templateAudienceMismatch: () => errors().templateAudienceMismatch(),
  templateInvalid: () => errors().templateInvalid(),
  testPhoneInvalid: () => errors().testPhoneInvalid(),
  ticketCodeFormat: () => errors().ticketCodeFormat(),
  ticketCodePrefix: () => errors().ticketCodePrefix(),
  ticketCodeTaken: () => errors().ticketCodeTaken(),
  ticketLimitCap: () =>
    errors().ticketLimitCap({
      min: TICKET_LIMIT_CAP_MIN,
      max: TICKET_LIMIT_CAP_MAX,
    }),
  ticketLimitMode: () => errors().ticketLimitMode(),
  ticketLimitReached: () => errors().ticketLimitReached(),
  ticketLimitScope: () => errors().ticketLimitScope(),
  volunteerOnlyItem: ({ item }) => item && errors().volunteerOnlyItem({ item }),
  whatsappDoorLocked: () => errors().whatsappDoorLocked(),
};

/**
 * What to tell the operator about a refused admin request, read from the
 * `admin-errors` catalog the route inlined.
 *
 * The error's own message is an English diagnostic and is never shown.
 *
 * @param err - The refusal.
 * @returns The message, or `undefined` when the server named no reason the
 *   client knows; the caller then shows its generic line.
 */
export const refusalMessage = (err: ApiError): string | undefined => {
  const reason = err.details?.reason;

  if (!reason || !Object.hasOwn(MESSAGES, reason)) return undefined;

  return MESSAGES[reason](err.details);
};

/**
 * The warning shown when an armed control cancels a click that would leave the
 * page, from the `admin-errors` catalog every page with such a control inlines.
 */
export const leaveNotConfirmedMessage = (): string =>
  errors().leaveNotConfirmed();
