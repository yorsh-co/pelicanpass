/**
 * Why an administrator request was refused, when the error code alone does not
 * say.
 *
 * One `CONFLICT` or `VALIDATION_ERROR` covers several refusals an operator has
 * to tell apart ("that code is taken" against "the role cannot change now"), so
 * admin services attach one of these to the error's details. The admin client
 * shows the matching `admin-errors` message; the error's own message is an
 * English diagnostic and never reaches the page.
 *
 * Serialised into error responses, so treat it as public API surface.
 *
 * `requestInProgress` is the one not raised by an admin service: the
 * idempotency middleware attaches it on every route it guards, the raffle
 * included, and the raffle page reads it directly.
 */
export type AdminRefusal =
  | 'attendeeArchived'
  | 'attendeeNotFound'
  | 'audienceInvalid'
  | 'invalidAttendee'
  | 'itemAlreadyRedeemed'
  | 'itemNotEntitled'
  | 'itemNotRedeemed'
  | 'listChanged'
  | 'nameInvalid'
  | 'optionNotAllowed'
  | 'pauseBeforeRetry'
  | 'phoneInvalid'
  | 'phoneMissing'
  | 'previewExpired'
  | 'previewMissing'
  | 'reasonInvalid'
  | 'redemptionChanged'
  | 'requestInProgress'
  | 'roleInvalid'
  | 'roleLocked'
  | 'runFinished'
  | 'runInProgress'
  | 'runInvalid'
  | 'runNotFound'
  | 'runNotPaused'
  | 'runNotRunning'
  | 'scheduleChanged'
  | 'scheduleDuplicateTime'
  | 'scheduleInvalid'
  | 'scheduleTextMissing'
  | 'scheduleTextTooLong'
  | 'scheduleTimeInvalid'
  | 'scheduleTooLong'
  | 'sendingDisabled'
  | 'templateAudienceMismatch'
  | 'templateInvalid'
  | 'testPhoneInvalid'
  | 'ticketCodeFormat'
  | 'ticketCodePrefix'
  | 'ticketCodeTaken'
  | 'ticketLimitCap'
  | 'ticketLimitMode'
  | 'ticketLimitReached'
  | 'ticketLimitScope'
  | 'volunteerOnlyItem'
  | 'whatsappDoorLocked';
