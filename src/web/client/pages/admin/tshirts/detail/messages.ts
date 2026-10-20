import { createAdminTshirtsMessages } from '../../../../../../i18n/generated/admin-tshirts.messages.ts';
import { readMessages } from '../../../../core/i18n.ts';

const tshirts = readMessages('admin-tshirts', createAdminTshirtsMessages);

/**
 * What the record page's script writes, read from the `admin-tshirts` catalog
 * the route inlined. Static text is rendered by `detail.ejs`.
 */
export const RECORD_COPY = {
  confirm: tshirts.recordConfirm(),
  redeeming: tshirts.recordRedeeming(),
  failed: tshirts.recordFailed(),
  forbidden: tshirts.recordForbidden(),
  redeemed: tshirts.recordRedeemed(),
  duplicate: tshirts.recordDuplicate(),
} as const;
