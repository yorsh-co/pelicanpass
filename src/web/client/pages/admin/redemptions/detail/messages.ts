import { createAdminRedemptionsMessages } from '../../../../../../i18n/generated/admin-redemptions.messages.ts';
import { readMessages } from '../../../../core/i18n.ts';

import type { RedemptionCorrection } from '../../../../../../constants/redemptions.ts';

const redemptions = readMessages(
  'admin-redemptions',
  createAdminRedemptionsMessages,
);

/**
 * What the record page's script writes, read from the `admin-redemptions`
 * catalog the route inlined. Static text is rendered by `detail.ejs`.
 */
export const RECORD_COPY = {
  action: {
    mark: redemptions.actionMark(),
    revert: redemptions.actionRevert(),
  } satisfies Record<RedemptionCorrection, string>,
  confirm: redemptions.actionConfirm(),
  reasonMissing: redemptions.actionReasonMissing(),
  failed: redemptions.actionFailed(),
  resyncing: redemptions.actionResyncing(),
  forbidden: redemptions.actionForbidden(),
  toast: {
    mark: redemptions.toastMarked(),
    revert: redemptions.toastReverted(),
  } satisfies Record<RedemptionCorrection, string>,
} as const;
