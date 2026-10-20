import { ensureAudience } from '../state/audience.ts';
import { createCheckinMessages } from '../../../../../../i18n/generated/checkin.messages.ts';
import { createQrMessages } from '../../../../../../i18n/generated/qr.messages.ts';
import { readMessages } from '../../../../core/i18n.ts';

import type { AttendeeRole } from '../../../../../../types/attendee.ts';
import type { AudienceCopy } from '../types.ts';

const checkin = readMessages('checkin', createCheckinMessages);
const qr = readMessages('qr', createQrMessages);

/**
 * The check-in copy for one audience, read from the `checkin` and `qr`
 * catalogs the route inlined. Wording that differs by audience is a `select`
 * in the catalog, so every audience gets the complete shape.
 */
const buildCopy = (audience: AttendeeRole): AudienceCopy => {
  const values = { audience };

  // One message for a request the client stopped waiting on and one the
  // server shed: either way, trying again shortly is the advice.
  const slowResponse = checkin.flowSlowResponse();

  return {
    init: {
      error: {
        VALIDATION_ERROR: checkin.initErrorValidation(values),
        NOT_FOUND: checkin.initErrorNotFound(),
        UNAUTHORIZED: checkin.initErrorUnauthorized(),
        RATE_LIMITED: checkin.initErrorRateLimited(),
      },
      unknownError: checkin.initUnknownError(),
      recoverableError: checkin.initRecoverableError(),
    },

    captcha: {
      missing: checkin.captchaMissing(),
      expired: checkin.captchaExpired(),
    },

    ticket: {
      header: checkin.ticketHeader(),
      defaultHint: checkin.ticketDefaultHint(),
      empty: checkin.ticketEmpty(),
      invalidCode: checkin.ticketInvalidCode(),
      invalidFormat: checkin.ticketInvalidFormat(),
      processing: checkin.ticketProcessing(values),
      success: checkin.ticketSuccess(values),
      error: {
        VALIDATION_ERROR: checkin.ticketErrorValidation(),
        NOT_FOUND: checkin.ticketErrorNotFound(),
        CAPTCHA_REQUIRED: checkin.ticketErrorCaptchaRequired(),
        RATE_LIMITED: checkin.ticketErrorRateLimited(),
        CHECKIN_NOT_OPEN: checkin.ticketErrorCheckinNotOpen(),
        EDGE_TIMEOUT: slowResponse,
        SERVICE_UNAVAILABLE: slowResponse,
      },
      unknownError: checkin.ticketUnknownError(),
    },

    verification: {
      header: checkin.verificationHeader(values),
      backButton: checkin.verificationBackButton(),
      defaultHint: checkin.verificationDefaultHint(),
      processing: checkin.verificationProcessing(),
      success: checkin.verificationSuccess(),
      error: {
        VALIDATION_ERROR: checkin.verificationErrorValidation(),
        NOT_FOUND: checkin.verificationErrorNotFound(),
        CAPTCHA_REQUIRED: checkin.verificationErrorCaptchaRequired(),
        RATE_LIMITED: checkin.verificationErrorRateLimited(),
        EDGE_TIMEOUT: slowResponse,
        SERVICE_UNAVAILABLE: slowResponse,
      },
      unknownError: checkin.verificationUnknownError(),
    },

    qr: {
      header: checkin.scannerHeader(),
      cameraButton: qr.cameraButton(),
      torchButton: qr.torchButton(),
      switchCameraButton: qr.switchCameraButton(),
      closeButton: qr.closeButton(),
      defaultHint: checkin.scannerDefaultHint(),
      cameraAccessRequest: checkin.scannerCameraAccessRequest(),
      help: checkin.scannerHelp(),
      presenceButton: checkin.scannerPresenceButton(),
      presenceNotYet: checkin.scannerPresenceNotYet(),
      presenceError: checkin.scannerPresenceError(),
      processing: checkin.scannerProcessing(),
      success: checkin.scannerSuccess(),
      error: {
        VALIDATION_ERROR: checkin.scannerErrorValidation(),
        NOT_FOUND: checkin.scannerErrorNotFound(),
        CAPTCHA_REQUIRED: checkin.scannerErrorCaptchaRequired(),
        RATE_LIMITED: checkin.scannerErrorRateLimited(),
        EDGE_TIMEOUT: slowResponse,
        SERVICE_UNAVAILABLE: slowResponse,
      },
      unknownError: checkin.scannerUnknownError(),
      // Empty, as it has always been on this scanner. Not a catalog message: an
      // empty one would still render as `[]` in the pseudo-locale.
      cameraAccessError: '',
    },

    success: {
      greeting: (name) => checkin.successGreeting({ name }),
      greetingFallback: checkin.successGreetingFallback(),
      numberLabel: checkin.successNumberLabel(),
      success: checkin.successSuccess(),
      redirect: checkin.successRedirect(),
      help: checkin.successHelp(),
    },

    userPreview: {
      ticketLabel: checkin.userPreviewTicketLabel(),
      nameLabel: checkin.userPreviewNameLabel(),
      phoneLabel: checkin.userPreviewPhoneLabel(),
    },

    lockout: {
      rateLimit: checkin.lockoutRateLimit(),
    },
  };
};

/** Fallback hints for a flow transition called without a message. */
export const FLOW_COPY = {
  processing: checkin.flowProcessing(),
  error: checkin.flowError(),
} as const;

const cache = new Map<AttendeeRole, AudienceCopy>();

/**
 * The check-in copy for one audience, built once per audience.
 *
 * @param options.audience - Defaults to the audience defined in "state" or
 *   "body".
 */
export const getAudienceCopy = (
  options: { audience?: AttendeeRole } = {},
): AudienceCopy => {
  const { audience = ensureAudience() } = options;

  let copy = cache.get(audience);

  if (!copy) {
    copy = buildCopy(audience);
    cache.set(audience, copy);
  }

  return copy;
};
