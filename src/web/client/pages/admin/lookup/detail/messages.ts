import { createAdminLookupMessages } from '../../../../../../i18n/generated/admin-lookup.messages.ts';
import { readMessages } from '../../../../core/i18n.ts';

const lookup = readMessages('admin-lookup', createAdminLookupMessages);

/**
 * What the record page's script writes, read from the `admin-lookup` catalog
 * the route inlined. Static text is rendered by `detail.ejs`.
 */
export const RECORD_COPY = {
  mark: lookup.recordMark(),
  confirm: lookup.recordConfirm(),
  notOpen: lookup.recordNotOpen(),
  forbidden: lookup.recordForbidden(),
  failed: lookup.recordFailed(),
  marked: lookup.recordMarked(),
} as const;
