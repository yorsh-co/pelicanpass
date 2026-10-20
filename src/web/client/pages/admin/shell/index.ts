import api from '../../../core/api/index.ts';
import { qsOptional } from '../../../layouts/main/dom.ts';
import { logger } from '../../../modules/log/logger.ts';

/**
 * The administrator shell.
 *
 * Loaded by `layouts/admin.ejs` on every administrator screen, so it owns only
 * what the rail owns: the drawer below the breakpoint, and sign-out. Anything
 * that belongs to one screen belongs in that screen's bundle.
 *
 * Both setups return quietly when their control is absent. The rail renders on
 * every page this bundle loads on today, but an inert handler is a cheaper
 * failure than a module that throws before the rest of it runs — which is
 * exactly what `layouts/main/dom.ts` used to do to this surface.
 */

/** Icon ligature naming what the next tap does. */
const MENU_ICON = { closed: 'menu', open: 'close' } as const;

/** Whether the off-canvas rail is currently open. */
const isOpen = (): boolean => document.body.dataset.adminDrawer === 'open';

/**
 * Wires the drawer toggle.
 *
 * The open state lives on `<body>` rather than on the rail, because that is
 * what the stylesheet needs in order to shift the page as well as the rail.
 *
 * Deliberately no focus trap: with JavaScript off this rail is a plain stacked
 * list above the content, and a modal trap is the one enhancement that cannot
 * degrade back to that.
 */
const setupDrawer = (): void => {
  const button = qsOptional<HTMLButtonElement>('[data-admin-shell="menu"]');

  if (!button) return;

  const nav = qsOptional('#admin-rail-nav');
  const icon = button.querySelector('.material-symbols-outlined');

  const setOpen = (open: boolean): void => {
    document.body.dataset.adminDrawer = open ? 'open' : 'closed';

    if (icon) icon.textContent = open ? MENU_ICON.open : MENU_ICON.closed;

    // The labels ride on the button, rendered from admin-shell.menu.*, so the
    // shell needs no inlined catalog.
    const label = open ? button.dataset.labelClose : button.dataset.labelOpen;

    if (label) button.setAttribute('aria-label', label);

    button.setAttribute('aria-expanded', String(open));
  };

  // Announces that the drawer is under script control. The stylesheet gates
  // every collapse rule on this attribute, so a reader with no JavaScript keeps
  // the rail as a plain stacked list instead of one that can never be opened.
  setOpen(false);

  button.addEventListener('click', () => {
    setOpen(!isOpen());
  });

  // Every link here is a full page load, so this matters less than it looks —
  // except for a link to the page already open, which would otherwise leave the
  // drawer sitting over content it did not change.
  nav?.addEventListener('click', () => {
    setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen()) return;

    setOpen(false);

    // Focus goes back to what opened it, not to wherever it happened to be.
    button.focus();
  });
};

/**
 * Ends the session and returns to the sign-in form.
 *
 * @param button - The control, disabled for the duration.
 */
const signOut = async (button: HTMLButtonElement): Promise<void> => {
  button.disabled = true;

  try {
    await api.admin.logout();
  } catch (err) {
    logger.warn(
      'admin',
      err instanceof Error ? err.message : 'Sign-out failed',
    );
  }

  // Navigate either way. A failed sign-out leaves the session alive server-side,
  // but keeping the operator on a page that claims they are signed in is worse
  // than sending them to a form that will tell them the truth.
  window.location.assign('/admin/login');
};

/**
 * Wires sign-out.
 *
 * Still requires JavaScript — it is a `POST` through `api.admin.logout()`, and
 * was before it moved here. The rail is the only place it now lives.
 */
const setupSignOut = (): void => {
  const button = qsOptional<HTMLButtonElement>('[data-admin-shell="logout"]');

  if (!button) return;

  button.addEventListener('click', () => {
    void signOut(button);
  });
};

setupDrawer();
setupSignOut();
