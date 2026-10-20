import { qs } from './dom.ts';

/**
 * The chrome `layouts/main.ejs` renders on every page it serves.
 *
 * Resolved once at import, and throwing if either element is missing, because
 * on a page served through that layout both are guaranteed by the template —
 * the boot screen unconditionally, the logout button through the footer's
 * `showLogout`.
 *
 * That is also why this lives apart from `dom.ts`. A module body runs in full
 * the first time it is imported, whichever binding the importer asked for, so
 * keeping these lookups beside `qs` made every page that wanted the selector
 * pay for chrome it does not have. `layouts/plain` has neither element, which
 * took `/admin/login` and `/admin` down: the throw happened before the page's
 * own module could attach a single listener.
 *
 * Import this only from a page served through `layouts/main`.
 */
const layoutDom = Object.freeze({
  bootScreen: qs('[data-main="boot-screen"]'),
  logoutBtn: qs<HTMLButtonElement>('[data-footer="logout"]'),
});

export default layoutDom;
