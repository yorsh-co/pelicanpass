import { createAdminLoginMessages } from '../../../../../i18n/generated/admin-login.messages.ts';
import { readMessages } from '../../../core/i18n.ts';

const login = readMessages('admin-login', createAdminLoginMessages);

/**
 * What the sign-in form says when the server's own message is not worth
 * showing, read from the `admin-login` catalog the route inlined.
 */
export const LOGIN_COPY = {
  failed: login.errorFailed(),
  blocked: login.errorBlocked(),
  offline: login.errorOffline(),
  captchaRequired: login.errorCaptchaRequired(),

  /** A spent attempt budget with a known wait, in whole minutes. */
  blockedFor: (minutes: number): string => login.errorBlockedFor({ minutes }),
} as const;
