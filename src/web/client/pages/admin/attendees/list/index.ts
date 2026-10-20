import api from '../../../../core/api/index.ts';
import toast from '../../../../modules/ui/toast.ts';
import { ApiError } from '../../../../core/api/api.error.ts';
import { logger } from '../../../../modules/log/logger.ts';
import { readDoorCopy } from './messages.ts';
import { setupLimit } from './limit-panel.ts';
import { openRowsOnClick } from '../../shared/row-open.ts';
import { refusalMessage } from '../../shared/refusal.ts';

import type { DoorOverview } from '../../../../../../types/whatsapp-door.ts';

/**
 * The roster's one enhancement: opening a record by clicking its row.
 *
 * Everything else on this screen — the filters, the search, the pager — is a
 * form post and works with this bundle absent. So does opening a record: the
 * name in the first cell is a submit button, and all this file does is let the
 * rest of the row press it. With the script gone the roster loses a
 * convenience, not a capability.
 */

/** Wires every row in the roster. */
const setupRows = (): void => {
  openRowsOnClick(
    document.querySelectorAll<HTMLTableRowElement>('.admin-table tbody tr'),
  );
};

/**
 * Wires the door message switch, for administrators the route showed it to.
 *
 * The page may have been rendered by a POST, so it is rewritten in place from
 * the overview the switch answers with rather than reloaded.
 */
const setupDoor = (): void => {
  const panel = document.querySelector<HTMLElement>('[data-door]');
  const button = panel?.querySelector<HTMLButtonElement>('[data-door-toggle]');

  if (!panel || !button) return;

  const copy = readDoorCopy();
  const state = panel.querySelector<HTMLElement>('[data-door-state]');
  const spend = panel.querySelector<HTMLElement>('[data-door-spend]');
  const budget = panel.querySelector<HTMLElement>('[data-door-budget]');
  const error = panel.querySelector<HTMLElement>('[data-door-error]');

  const render = (overview: DoorOverview): void => {
    const on = overview.switchOn && overview.unlocked;

    button.dataset.enabled = String(overview.switchOn);
    button.textContent = overview.switchOn
      ? copy.doorTurnOff()
      : copy.doorTurnOn();

    if (state) {
      state.textContent = copy.doorState({ on: on ? 'yes' : 'no' });
      state.classList.toggle('is-on', on);
      state.classList.toggle('is-off', !on);
    }

    if (spend) {
      spend.textContent = copy.doorSpend({
        spent: overview.spentUsd,
        budget: overview.budgetUsd,
        price: overview.priceUsd,
      });
    }

    if (budget) {
      budget.hidden = !(
        !overview.availability.available &&
        overview.availability.reason === 'overBudget'
      );
    }
  };

  const report = (err: unknown): void => {
    if (!error) return;

    if (err instanceof ApiError) {
      if (err.code === 'UNAUTHORIZED') {
        window.location.assign('/admin/login');

        return;
      }

      if (err.code === 'FORBIDDEN') {
        error.textContent = copy.doorForbidden();
        error.hidden = false;

        return;
      }
    }

    logger.warn('admin', err instanceof Error ? err.message : 'Switch failed');

    error.textContent =
      err instanceof ApiError
        ? (refusalMessage(err) ?? copy.doorFailed())
        : copy.doorFailed();
    error.hidden = false;
  };

  button.addEventListener('click', () => {
    const enabled = button.dataset.enabled !== 'true';

    button.disabled = true;
    if (error) error.hidden = true;

    api.admin.whatsappDoor
      .setSwitch(enabled)
      .then((overview) => {
        render(overview);

        void toast.success(copy.doorSaved({ on: enabled ? 'yes' : 'no' }));
      })
      .catch(report)
      .finally(() => {
        button.disabled = false;
      });
  });
};

setupRows();
setupDoor();
setupLimit();
