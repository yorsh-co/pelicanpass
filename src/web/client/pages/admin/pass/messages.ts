import { createAdminPassMessages } from '../../../../../i18n/generated/admin-pass.messages.ts';
import { readMessages } from '../../../core/i18n.ts';

const pass = readMessages('admin-pass', createAdminPassMessages);

/**
 * What the pass screen's script writes, read from the `admin-pass` catalog the
 * route inlined. Static text is rendered by `pass/index.ejs`.
 */
export const PASS_ADMIN_COPY = {
  saved: pass.saved(),
  reset: pass.reset(),
  resetConfirm: pass.resetConfirm(),
  resetDone: pass.resetDone(),
  failed: pass.failed(),
  forbidden: pass.forbidden(),
  missingTime: pass.invalidMissingTime(),
  missingText: pass.invalidMissingText(),
  duplicateTime: pass.invalidDuplicateTime(),
} as const;
