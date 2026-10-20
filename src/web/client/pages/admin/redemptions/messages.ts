import { createAdminRedemptionsMessages } from '../../../../../i18n/generated/admin-redemptions.messages.ts';
import { readMessages } from '../../../core/i18n.ts';

const redemptions = readMessages(
  'admin-redemptions',
  createAdminRedemptionsMessages,
);

/**
 * What the redemptions screen's script writes, read from the
 * `admin-redemptions` catalog the route inlined. Static text is rendered by
 * `index.ejs`.
 */
export const SUMMARY_COPY = {
  progress: (share: number): string => redemptions.summaryProgress({ share }),
  updated: (time: string): string => redemptions.stateUpdated({ time }),
  stale: redemptions.stateStale(),
} as const;
