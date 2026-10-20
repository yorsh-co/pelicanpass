import { adminChrome } from '../../middleware/admin-chrome.middleware.ts';
import { requireWebAuth } from '../../middleware/auth.middleware.ts';
import { noStore } from '../../middleware/no-store.middleware.ts';
import { requireAdminScopeWeb } from '../../middleware/permission.middleware.ts';

import type { RequestHandler } from 'express';

import type { AdminScope } from '../../constants/admin-scopes.ts';

/**
 * The middleware every administrator page mounts behind, in the one order that
 * works.
 *
 * **The order is the whole point of this existing.** Session, then scope, then
 * chrome: `adminChrome` reads the database to build the navigation, and running
 * it for somebody who is about to be redirected is work done for a response
 * nobody sees. Spelled out per route, that ordering is three lines a reader has
 * to check every time and a copy-paste can silently reorder.
 *
 * What it deliberately does **not** hide is the `res.render` call. Each route
 * still names its own view, title and `navKey` in full, because those are the
 * parts that differ and the parts a reader comes to the file looking for.
 *
 * The admin shell shipped without this, on the grounds that abstracting a
 * single use is worse than repeating it, and said the third screen would be
 * where it earned its keep. This is that screen.
 *
 * `noStore` runs first and is the one member that does not depend on the order:
 * it is here rather than on each route because every page this assembles
 * renders attendee data onto a device this deployment does not own, and a
 * screen added later must inherit that without anybody remembering to.
 *
 * @param scope - Scope the page requires, or `null` for a page that only needs
 *   a session. `/admin` itself passes `null`: it has no gate, and it renders
 *   only what `adminChrome` says the caller may see.
 * @returns The handlers to spread ahead of the route's own.
 */
export const adminPage = (scope: AdminScope | null): RequestHandler[] => [
  noStore,
  requireWebAuth('admin', '/admin/login'),
  ...(scope ? [requireAdminScopeWeb(scope, '/admin')] : []),
  adminChrome,
];
