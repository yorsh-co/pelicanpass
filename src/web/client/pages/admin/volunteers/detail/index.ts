import api from '../../../../core/api/index.ts';
import toast, {
  deferToast,
  takeDeferredToast,
} from '../../../../modules/ui/toast.ts';
import { ApiError } from '../../../../core/api/api.error.ts';
import { logger } from '../../../../modules/log/logger.ts';
import { setChallengeRecovery } from '../../../../modules/ui/challenge-gate.ts';
import { isRedemptionItem } from '../../../../../../constants/pass.ts';
import { VOLUNTEERS_COPY } from '../messages.ts';
import { refusalMessage } from '../../shared/refusal.ts';

import type { VolunteerPermissions } from '../../../../core/api/api.admin.volunteers.ts';

/**
 * The volunteer record's form: reads the six values, saves them, and shows
 * what was stored.
 *
 * The stations are disabled while collections are off but keep their ticks,
 * and are sent as they stand: the server accepts stations with collections
 * off, and switching collections back on then restores them.
 *
 * A save that wrote something reloads the record, as the redemptions screen
 * does, so the tier chip, the form and the history are the server's rendering
 * of what was stored; the confirmation is deferred across the reload. A save
 * that matched what was stored writes nothing, so there is nothing to reload:
 * it confirms in place and shows the values as the server normalised them.
 */

const SAVED_TOAST = 'volunteers:saved';

const form = document.querySelector<HTMLFormElement>('[data-volunteer="form"]');
const canRedeem = form?.querySelector<HTMLInputElement>(
  '[data-volunteer="canRedeem"]',
);
const stations = form?.querySelector<HTMLFieldSetElement>(
  '[data-volunteer="stations"]',
);
const hint = form?.querySelector<HTMLElement>('[data-volunteer="hint"]');
const error = form?.querySelector<HTMLElement>('[data-volunteer="error"]');
const save = form?.querySelector<HTMLButtonElement>('[data-volunteer="save"]');

/** The station boxes, in the order the page lists them. */
const stationBoxes = (): HTMLInputElement[] => [
  ...(stations?.querySelectorAll<HTMLInputElement>(
    'input[name="redeemScopes"]',
  ) ?? []),
];

/**
 * Reads a field of the form by name.
 *
 * @param name - The field's `name`.
 */
const field = (name: string): HTMLInputElement | null =>
  form?.querySelector<HTMLInputElement>(`input[name="${name}"]`) ?? null;

/** Disables the stations with the switch, and says why they would grant nothing. */
const syncStations = (): void => {
  if (!canRedeem || !stations || !hint) return;

  stations.disabled = !canRedeem.checked;

  hint.textContent = !canRedeem.checked
    ? VOLUNTEERS_COPY.stationsOff
    : stationBoxes().some((box) => box.checked)
      ? ''
      : VOLUNTEERS_COPY.stationsEmpty;
};

/**
 * A blank label is sent as `null`; the server trims and does the same.
 *
 * @param name - The text field's `name`.
 */
const label = (name: string): string | null => {
  const value = field(name)?.value.trim() ?? '';

  return value === '' ? null : value;
};

/** Reads the form as the API takes it. */
const read = (): VolunteerPermissions => ({
  canRedeem: canRedeem?.checked ?? false,
  redeemScopes: stationBoxes().flatMap((box) =>
    box.checked && isRedemptionItem(box.value) ? [box.value] : [],
  ),
  canDraw: field('canDraw')?.checked ?? false,
  showAdminLink: field('showAdminLink')?.checked ?? false,
  team: label('team'),
  teamRole: label('teamRole'),
  checkinTime: label('checkinTime'),
});

/**
 * Shows stored values in the form.
 *
 * @param values - What the server answered with.
 */
const write = (values: VolunteerPermissions): void => {
  if (canRedeem) canRedeem.checked = values.canRedeem;

  for (const box of stationBoxes()) {
    box.checked = isRedemptionItem(box.value)
      ? values.redeemScopes.includes(box.value)
      : false;
  }

  const draw = field('canDraw');
  const link = field('showAdminLink');
  const team = field('team');
  const role = field('teamRole');
  const time = field('checkinTime');

  if (draw) draw.checked = values.canDraw;
  if (link) link.checked = values.showAdminLink;
  if (team) team.value = values.team ?? '';
  if (role) role.value = values.teamRole ?? '';
  if (time) time.value = values.checkinTime ?? '';

  syncStations();
};

/** Renders the record again from the server, as redemptions/detail does. */
const reloadRecord = (): void => {
  const record = document.querySelector<HTMLFormElement>('#record');

  if (record) record.requestSubmit();
  else window.location.reload();
};

/**
 * Puts a failure in the form's error line, or acts on it.
 *
 * @param err - Whatever the request threw.
 */
const reportError = (err: unknown): void => {
  if (!error) return;

  if (err instanceof ApiError) {
    if (err.code === 'UNAUTHORIZED') {
      window.location.assign('/admin/login');

      return;
    }

    if (err.code === 'FORBIDDEN') {
      error.textContent = VOLUNTEERS_COPY.forbidden;

      return;
    }

    if (err.code === 'NOT_FOUND') {
      error.textContent = VOLUNTEERS_COPY.notFound;

      return;
    }

    if (err.code === 'VALIDATION_ERROR') {
      error.textContent = refusalMessage(err) ?? VOLUNTEERS_COPY.failed;

      return;
    }
  }

  logger.warn(
    'admin',
    err instanceof Error ? err.message : 'Volunteer save failed',
  );

  error.textContent = VOLUNTEERS_COPY.failed;
};

if (form && canRedeem && stations && hint && error && save) {
  const { attendeeId } = form.dataset;

  canRedeem.addEventListener('change', syncStations);
  stations.addEventListener('change', syncStations);

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    // A second press while a save is in flight must not send it twice.
    if (!attendeeId || save.disabled) return;

    save.disabled = true;
    error.textContent = '';

    api.admin.volunteers
      .save(attendeeId, read())
      .then(({ volunteer, changed }) => {
        if (changed) {
          deferToast(SAVED_TOAST);
          reloadRecord();

          return;
        }

        write(volunteer);
        void toast.success(VOLUNTEERS_COPY.unchanged);
        save.disabled = false;
      })
      .catch((err: unknown) => {
        reportError(err);
        save.disabled = false;
      });
  });

  // This page is rendered by a `POST`, so recovering from an expired edge
  // challenge means submitting the record again, as redemptions/detail does.
  setChallengeRecovery(reloadRecord);
}

if (takeDeferredToast() === SAVED_TOAST) {
  void toast.success(VOLUNTEERS_COPY.saved);
}
