import { createAdminAttendeesMessages } from '../../../../../../i18n/generated/admin-attendees.messages.ts';
import { readMessages } from '../../../../core/i18n.ts';

import type { DoorSkipReason } from '../../../../../../types/whatsapp-door.ts';

const attendees = readMessages('admin-attendees', createAdminAttendeesMessages);

/**
 * What the record form's script writes, read from the `admin-attendees`
 * catalog the route inlined. Static text is rendered by `form.ejs`.
 */
export const FORM_COPY = {
  saved: attendees.formSaved(),
  created: attendees.formCreated(),
  archived: attendees.dangerArchived(),
  restored: attendees.dangerRestored(),
  nicknameRemoved: attendees.nicknameRemoved(),
  saveFailed: attendees.formSaveFailed(),
  actionFailed: attendees.formActionFailed(),
  forbidden: attendees.formForbidden(),
  archive: attendees.dangerArchive(),
  confirm: attendees.dangerConfirm(),
  checkinMark: attendees.checkinMark(),
  checkinConfirm: attendees.checkinConfirm(),
  checkinMarked: attendees.checkinMarked(),
  checkinAlreadyPresent: attendees.checkinAlreadyPresent(),
  checkinNotOpen: attendees.checkinNotOpen(),
  checkinForbidden: attendees.checkinForbidden(),
  checkinFailed: attendees.checkinFailed(),
  checkinUnsaved: attendees.checkinUnsaved(),
  itemNone: attendees.formItemNone(),
  itemUnavailable: attendees.formItemUnavailable(),
} as const;

/** The label of a stored value that is no longer on the approved list. */
export const itemOffListLabel = (value: string): string =>
  attendees.formItemOffList({ value });

/** Which save a door message rode on, which is what its toast opens with. */
export type WhatsappContext = 'created' | 'saved';

/** The door message's toasts, per save. */
export const WHATSAPP_COPY: Record<
  WhatsappContext,
  { sent: string; failed: string; skipped: (reason: DoorSkipReason) => string }
> = {
  created: {
    sent: attendees.formCreatedWhatsappSent(),
    failed: attendees.formCreatedWhatsappFailed(),
    skipped: (reason) => attendees.formCreatedWhatsappSkipped({ reason }),
  },
  saved: {
    sent: attendees.formSavedWhatsappSent(),
    failed: attendees.formSavedWhatsappFailed(),
    skipped: (reason) => attendees.formSavedWhatsappSkipped({ reason }),
  },
};

/**
 * The warning toast for a ticket limit that is reached or exceeded.
 *
 * @param used - Tickets counted, with the one just issued.
 * @param cap - The limit.
 */
export const limitExceededMessage = (used: number, cap: number): string =>
  attendees.limitExceeded({ used, cap });
