import { createAdminAttendeesMessages } from '../../../../../../i18n/generated/admin-attendees.messages.ts';
import { readMessages } from '../../../../core/i18n.ts';

/**
 * The `admin-attendees` catalog, for the door switch and ticket limit panels'
 * scripts. Read lazily: the route inlines it only for administrators who see a
 * panel.
 */
export const readDoorCopy = () =>
  readMessages('admin-attendees', createAdminAttendeesMessages);
