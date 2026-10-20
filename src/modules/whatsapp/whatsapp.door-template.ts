import {
  WHATSAPP_TEMPLATES,
  isWhatsappTemplateKey,
} from '../../constants/whatsapp-templates.ts';

import type { AttendeeRole } from '../../types/attendee.ts';

/**
 * Whether a configured door template can be sent to an attendee of `role`.
 *
 * @param key - The configured registry key.
 * @param role - The role the key is configured for.
 * @returns `null` when `key` names a registry entry offered to `role`;
 *   otherwise why not, phrased to follow the variable's name.
 */
export const doorTemplateProblem = (
  key: string,
  role: AttendeeRole,
): string | null => {
  if (!isWhatsappTemplateKey(key)) {
    return 'names no entry in src/constants/whatsapp-templates.ts';
  }

  const roles: readonly AttendeeRole[] = WHATSAPP_TEMPLATES[key].roles;

  if (!roles.includes(role)) {
    return `is not offered to the ${role} role`;
  }

  return null;
};
