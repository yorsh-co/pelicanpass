import { createAdminVolunteersMessages } from '../../../../../i18n/generated/admin-volunteers.messages.ts';
import { readMessages } from '../../../core/i18n.ts';

const volunteers = readMessages(
  'admin-volunteers',
  createAdminVolunteersMessages,
);

/**
 * What the volunteer screens' scripts write, read from the
 * `admin-volunteers` catalog the routes inlined. Static text is rendered by
 * `index.ejs` and `detail.ejs`.
 */
export const VOLUNTEERS_COPY = {
  count: (count: number): string => volunteers.listCount({ count }),
  saved: volunteers.toastSaved(),
  unchanged: volunteers.toastUnchanged(),
  failed: volunteers.errorFailed(),
  forbidden: volunteers.errorForbidden(),
  notFound: volunteers.errorNotFound(),
  stationsOff: volunteers.recordStationsOff(),
  stationsEmpty: volunteers.recordStationsEmpty(),
} as const;
