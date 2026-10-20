import type { RequestHandler } from 'express';

import { ADMIN_NAV } from '../constants/admin-nav.ts';
import { getMessages } from '../i18n/server.ts';
import { getAdminPermission } from '../modules/admin/admin.repository.ts';

import type { AdminNavKey } from '../constants/admin-nav.ts';
import type { MessagesOf } from '../i18n/generated/registry.ts';
import type { AdminSession } from '../types/session.ts';

/** Each section's label, total so a new section cannot ship unnamed. */
const NAV_LABELS: Record<
  AdminNavKey,
  (shell: MessagesOf['admin-shell']) => string
> = {
  attendees: (shell) => shell.navAttendees(),
  lookup: (shell) => shell.navLookup(),
  whatsapp: (shell) => shell.navWhatsapp(),
  redemptions: (shell) => shell.navRedemptions(),
  tshirts: (shell) => shell.navTshirts(),
  volunteers: (shell) => shell.navVolunteers(),
  metrics: (shell) => shell.navMetrics(),
  survey: (shell) => shell.navSurvey(),
  pass: (shell) => shell.navPass(),
  exports: (shell) => shell.navExports(),
  import: (shell) => shell.navImport(),
  admins: (shell) => shell.navAdmins(),
};

/**
 * Puts the administrator shell's chrome on the response.
 *
 * A separate file from `permission.middleware.ts` deliberately: this decides
 * what an operator is *shown*, not what they may *do*. The gate file is
 * security-critical enough that code with no bearing on a decision should stay
 * out of it.
 *
 * Mount after the session and after any scope gate the route carries — chrome
 * must not run for someone who is about to be redirected.
 *
 * **Known cost:** a scope-gated page reads `getAdminPermission` twice per
 * render, once in `requireAdminScopeWeb` and once here. `/admin` itself has no
 * scope gate and costs one. Accepted: the population is a handful of people on
 * a tailnet, `adminSessionLimiter` caps them at 20/60s, and caching the
 * permission on the request would mean touching the gate to read a cache.
 * Revisit only if it ever measures.
 */
export const adminChrome: RequestHandler = async (req, res, next) => {
  const shell = getMessages(res.locals.locale, 'admin-shell');

  res.locals.shell = shell;

  try {
    const session = req.session as AdminSession | undefined;

    // The header name comes off the session rather than the database. The
    // permission read projects scopes and the active flag only, and widening a
    // read both gates depend on to carry a display string is the wrong trade.
    // AdminSession.username exists for exactly this.
    res.locals.adminUsername = session?.username ?? '';

    const adminId = session?.adminId;
    const permission = adminId ? await getAdminPermission(adminId) : null;

    // A deactivated account gets an empty nav rather than a redirect, matching
    // hasAdminScope, which already refuses every gated screen on the same
    // condition. Chrome is not a gate and must not invent a policy of its own.
    const scopes = permission?.is_active ? permission.admin_scopes : [];

    // Exposed as well as used, because a screen gated on one scope often shows
    // controls that need another — the roster opens on `attendees:read` and its
    // create and archive buttons belong to `attendees:write`. This read has
    // already happened, so the alternative is a second `getAdminPermission` per
    // render to learn something this function is holding.
    //
    // Still not a gate. It decides what is *drawn*; every route and every
    // endpoint enforces its own scope regardless of what a view chose to show.
    res.locals.adminScopes = scopes;

    res.locals.adminNav = ADMIN_NAV.filter((item) =>
      scopes.includes(item.scope),
    ).map((item) => ({ ...item, label: NAV_LABELS[item.key](shell) }));

    next();
  } catch (err) {
    next(err);
  }
};
