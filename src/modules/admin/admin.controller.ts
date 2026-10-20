import type { RequestHandler } from 'express';

import { AdminService } from './admin.service.ts';

import { getMessages, resolveLocale } from '../../i18n/server.ts';
import { getAdminPermission } from './admin.repository.ts';
import { UnauthorizedError } from '../../shared/errors/app-error.ts';
import { readStringField } from '../../shared/utils/request-body.ts';

import type { AdminScope } from '../../constants/admin-scopes.ts';
import type { MessagesOf } from '../../i18n/generated/registry.ts';
import type { AdminSession } from '../../types/session.ts';

/**
 * What each scope permits, as the identity payload reports it. Total, so a new
 * scope cannot ship without a label.
 *
 * @param shell - `admin-shell` in the caller's locale.
 */
const scopeLabels = (shell: MessagesOf['admin-shell']) =>
  ({
    'attendees:read': shell.scopeAttendeesRead(),
    'attendees:write': shell.scopeAttendeesWrite(),
    'attendees:import': shell.scopeAttendeesImport(),
    'checkin:write': shell.scopeCheckinWrite(),
    'redemptions:read': shell.scopeRedemptionsRead(),
    'redemptions:write': shell.scopeRedemptionsWrite(),
    'raffle:read': shell.scopeRaffleRead(),
    'raffle:write': shell.scopeRaffleWrite(),
    'export:read': shell.scopeExportRead(),
    'metrics:read': shell.scopeMetricsRead(),
    'admins:write': shell.scopeAdminsWrite(),
    'whatsapp:send': shell.scopeWhatsappSend(),
    'survey:write': shell.scopeSurveyWrite(),
    'pass:write': shell.scopePassWrite(),
    'volunteers:write': shell.scopeVolunteersWrite(),
    'tshirt:redeem': shell.scopeTshirtRedeem(),
    'attendees:limit': shell.scopeAttendeesLimit(),
  }) satisfies Record<AdminScope, string>;

/**
 * Signs an administrator in.
 *
 * Every credential failure reaches here as an `UnauthorizedError` carrying one
 * message, so there is nothing to branch on and nothing to leak. The browser
 * follows a success with an ordinary navigation to `/admin` rather than being
 * redirected from here — the session cookie is what the next request needs, and
 * a fetch cannot act on a 303.
 */
export const login: RequestHandler = async (req, res, next) => {
  try {
    const username = readStringField(req.body, 'username');
    const password = readStringField(req.body, 'password');

    const service = new AdminService({ req, res });

    const identity = await service.login(username ?? '', password ?? '');

    res.setHeader('Cache-Control', 'no-store');

    res.json({ success: true, code: 'ADMIN_SIGNED_IN', data: identity });
  } catch (err) {
    next(err);
  }
};

/** Ends the administrator's session. */
export const logout: RequestHandler = async (req, res, next) => {
  try {
    const service = new AdminService({ req, res });

    await service.logout();

    res.json({ success: true, code: 'ADMIN_SIGNED_OUT' });
  } catch (err) {
    next(err);
  }
};

/**
 * Who the caller is and what they may do.
 *
 * The scopes are read from Postgres rather than echoed from the session, for
 * the same reason the gates re-read them: this is what the dashboard renders
 * its navigation from, and it should show what is true now rather than what was
 * true at sign-in.
 */
export const me: RequestHandler = async (req, res, next) => {
  try {
    const session = req.session as AdminSession | undefined;

    if (!session?.adminId) throw new UnauthorizedError();

    const permission = await getAdminPermission(session.adminId);

    if (!permission?.is_active) throw new UnauthorizedError();

    res.setHeader('Cache-Control', 'no-store');

    res.json({
      success: true,
      code: 'ADMIN_IDENTITY',
      data: {
        username: session.username,
        scopes: permission.admin_scopes,
        labels: scopeLabels(getMessages(resolveLocale(req), 'admin-shell')),
      },
    });
  } catch (err) {
    next(err);
  }
};
