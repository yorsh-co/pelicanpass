import layoutDom from './layout-dom.ts';

import api from '../../core/api/index.ts';
import { logger } from '../../modules/log/logger.ts';

/**
 * Wires the footer's "Sair" button to end the attendee session.
 *
 * Every surface reached with an attendee session leaves it the same way — the
 * pass, the staff scanner and the raffle — so the wiring lives here rather than
 * once per page.
 *
 * `/checkin` deliberately keeps its own. The button there abandons an
 * in-progress check-in with `api.checkin.reset()` and returns to the ticket
 * step: a different operation that happens to share a control. Folding it in
 * would mean a parameter for a single caller, or a half-finished check-in that
 * silently stops being reset.
 *
 * The button is disabled as it is tapped. The request is in flight until the
 * navigation replaces the page, and a second tap would send a second logout
 * against a session that is already gone.
 *
 * It navigates whether or not the request succeeds. An expired session answers
 * 401 and has nothing left to end, and a dead button is worse than landing on
 * `/checkin`, which routes a still-live session back.
 */
export const setupLogout = (): void => {
  layoutDom.logoutBtn.onclick = (event) => {
    void (async () => {
      (event.currentTarget as HTMLButtonElement).disabled = true;

      try {
        await api.attendee.logout();
      } catch (err) {
        logger.warn(
          'logout',
          err instanceof Error ? err.message : 'Logout failed',
        );
      }

      window.location.href = '/checkin';
    })();
  };
};
