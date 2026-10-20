import { PASS_WINDOW_MS } from '../../../../../constants/pass.ts';
import { createChromeMessages } from '../../../../../i18n/generated/chrome.messages.ts';
import { createQrMessages } from '../../../../../i18n/generated/qr.messages.ts';
import { createStaffMessages } from '../../../../../i18n/generated/staff.messages.ts';
import { readMessages } from '../../../core/i18n.ts';

import type {
  RedemptionItem,
  RedemptionOutcome,
} from '../../../../../constants/pass.ts';
import type { QrCopy } from '../../../modules/qr/qr.types.ts';

const staff = readMessages('staff', createStaffMessages);
const qr = readMessages('qr', createQrMessages);
const chrome = readMessages('chrome', createChromeMessages);

const ITEM_LABELS: Record<RedemptionItem, () => string> = {
  tshirt_volunteer: chrome.itemTshirtVolunteer,
  lunch: chrome.itemLunch,
  tshirt: chrome.itemTshirt,
  meal: chrome.itemMeal,
  drink: chrome.itemDrink,
};

const OUTCOMES: Record<
  RedemptionOutcome,
  (values: { item: string }) => string
> = {
  redeemed: staff.outcomeRedeemed,
  duplicate: staff.outcomeDuplicate,
  not_entitled: staff.outcomeNotEntitled,
};

/** The item's display name. */
const itemLabel = (item: RedemptionItem): string => ITEM_LABELS[item]();

/**
 * The scanner's own strings, in the shape `setupQr` takes.
 *
 * Annotated rather than inferred so `error` stays the open map `ErrorCopy`
 * describes: it is indexed with any `ApiErrorCode` the server might send.
 */
const STAFF_QR_COPY: QrCopy = {
  header: staff.scannerHeader(),
  cameraButton: qr.cameraButton(),
  torchButton: qr.torchButton(),
  switchCameraButton: qr.switchCameraButton(),
  closeButton: qr.closeButton(),
  defaultHint: staff.scannerDefaultHint(),
  cameraAccessRequest: staff.scannerCameraAccessRequest(),
  help: staff.scannerHelp(),
  processing: staff.scannerProcessing(),
  success: staff.scannerSuccess(),
  error: {
    VALIDATION_ERROR: staff.scannerErrorValidation({
      seconds: PASS_WINDOW_MS / 1000,
    }),
    NOT_FOUND: staff.scannerErrorNotFound(),
    FORBIDDEN: staff.scannerErrorForbidden(),
    RATE_LIMITED: staff.scannerErrorRateLimited(),
    INTERNAL_ERROR: staff.scannerErrorInternal(),
    EDGE_TIMEOUT: staff.slowResponse(),
    SERVICE_UNAVAILABLE: staff.slowResponse(),
  },
  unknownError: staff.scannerUnknownError(),
  cameraAccessError: staff.scannerCameraAccessError(),
};

/**
 * What the staff surface's script says, read from the `staff`, `qr` and
 * `chrome` catalogs the route inlined. Static text is rendered by `scan.ejs`;
 * this holds what the script writes after load. The wording and its rationale
 * live in src/i18n/messages/pt-BR/staff.json.
 */
export const STAFF_COPY = {
  volunteerBadge: chrome.roleVolunteer(),

  lookupFailed: staff.lookupFailed(),
  lookupRateLimited: staff.lookupRateLimited(),

  pending: staff.redemptionPending(),
  redeemed: staff.redemptionRedeemed(),
  notEntitled: staff.redemptionNotEntitled(),
  otherStation: staff.redemptionOtherStation(),

  itemLabel,

  /** An item's name with the attendee's choice for it, e.g. a size. */
  itemValue: (item: RedemptionItem, value: string): string =>
    staff.itemValue({ item: itemLabel(item), value }),

  /** The line shown after a redemption attempt. */
  outcome: (item: RedemptionItem, outcome: RedemptionOutcome): string =>
    OUTCOMES[outcome]({ item: itemLabel(item) }),

  redeemFailed: staff.redeemFailed(),
  redeemForbidden: staff.redeemForbidden(),
  slowResponse: staff.slowResponse(),
  serverError: staff.serverError(),

  /** Passed straight to `setupQr`, which owns the scanner's own messaging. */
  qr: STAFF_QR_COPY,
} as const;
