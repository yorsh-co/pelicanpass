import api from '../../../../core/api/index.ts';
import toast, {
  deferToast,
  takeDeferredToast,
} from '../../../../modules/ui/toast.ts';
import { ApiError } from '../../../../core/api/api.error.ts';
import { logger } from '../../../../modules/log/logger.ts';
import { qsOptional } from '../../../../layouts/main/dom.ts';
import {
  FORM_COPY,
  WHATSAPP_COPY,
  itemOffListLabel,
  limitExceededMessage,
} from './messages.ts';
import { combineToast } from './deferred-toast.ts';
import { setupLimitBanner } from './limit-banner.ts';
import { blankItemLabel } from './blank-item-label.ts';
import { rebuildRoleOptions } from './role-options.ts';
import {
  leaveNotConfirmedMessage,
  refusalMessage,
} from '../../shared/refusal.ts';
import { decodeExceeded, encodeExceeded } from '../../shared/ticket-limit.ts';
import {
  createUnloadGuard,
  stopLeaving,
} from '../../../../modules/ui/unload-guard.ts';

import type { ToastLevel } from '../../../../modules/ui/toast.ts';
import type { WhatsappContext } from './messages.ts';
import type { TicketLimitOverview } from '../../../../../../types/ticket-limit.ts';
import type { AttendeeFields } from '../../../../core/api/api.admin.attendees.ts';
import type {
  DoorOutcome,
  DoorSkipReason,
} from '../../../../../../types/whatsapp-door.ts';

/**
 * The record form: saving it, clearing a nickname, and archiving.
 *
 * The form element keeps `method="post"` even though this handler cancels the
 * native submit. Without the attribute the Enter key submits as **GET**, and
 * `maskUrlSecrets` redacts `password`, `token`, `code` and `t` — not `name`,
 * and not `phone`. Both the request serialiser and the rate limiter log the
 * URL, so a stray keypress would write an attendee's name and phone number into
 * the request log. If this bundle fails to load, the uncancelled submit is a
 * 404, which is the right way to fail.
 */

/**
 * Reads the form into the shape the endpoint expects.
 *
 * `FormData` rather than reading each input by id: it picks up the hidden
 * `role` input a checked-in record renders instead of a `<select>`, and it
 * leaves out the read-only ticket code on an edit, which carries no `name`
 * precisely so it is not sent.
 *
 * @param form - The record form.
 */
const readFields = (form: HTMLFormElement): AttendeeFields => {
  const data = new FormData(form);

  // `FormData.get` answers `string | File | null`, and stringifying a File
  // yields `[object File]` — a value the server would dutifully try to store.
  // No field here is a file, so anything that is not a string is treated as
  // absent.
  const read = (name: string): string => {
    const value = data.get(name);

    return typeof value === 'string' ? value : '';
  };

  const fields: AttendeeFields = {
    name: read('name'),
    phone: read('phone'),
    role: read('role'),
    mealOption: read('mealOption'),
    drinkOption: read('drinkOption'),
    tshirtSize: read('tshirtSize'),
    lunchOption: read('lunchOption'),
    tshirtVolunteerSize: read('tshirtVolunteerSize'),
    ticketCode: read('ticketCode'),
  };

  // Only where the page rendered the checkbox. A disabled or unticked box is
  // absent from `FormData`, which is a "no".
  if (form.querySelector('[name="sendWhatsapp"]')) {
    fields.sendWhatsapp = data.get('sendWhatsapp') !== null;
  }

  return fields;
};

/**
 * Puts a refusal where the operator is looking, or acts on it.
 *
 * A `ValidationError` and a `ConflictError` are shown by their reason: one
 * `CONFLICT` code covers several different refusals — "that code is taken" and
 * "the role cannot change now" — and `details.reason` tells them apart.
 * Anything else gets a line the operator can act on and a log entry that keeps
 * the detail.
 *
 * @param err - Whatever the request threw.
 * @param slot - The form's error line.
 * @param fallback - Line to show when the code carries no message of its own.
 * @param forbidden - Line for a withdrawn permission, which names the action.
 */
const reportError = (
  err: unknown,
  slot: HTMLElement | null,
  fallback: string = FORM_COPY.saveFailed,
  forbidden: string = FORM_COPY.forbidden,
): void => {
  if (err instanceof ApiError) {
    if (err.code === 'UNAUTHORIZED') {
      // The session died while the form sat open. A message here would be one
      // they cannot act on without leaving the page anyway.
      window.location.assign('/admin/login');

      return;
    }

    // The server's own message is English; the check-in refusal is shown from
    // the catalog instead, as the lookup screen does.
    if (err.code === 'CHECKIN_NOT_OPEN') {
      if (slot) slot.textContent = FORM_COPY.checkinNotOpen;

      return;
    }

    if (
      err.code === 'VALIDATION_ERROR' ||
      err.code === 'CONFLICT' ||
      err.code === 'NOT_FOUND'
    ) {
      if (slot) slot.textContent = refusalMessage(err) ?? fallback;

      return;
    }

    if (err.code === 'FORBIDDEN') {
      if (slot) slot.textContent = forbidden;

      return;
    }
  }

  logger.warn('admin', err instanceof Error ? err.message : 'Save failed');

  if (slot) slot.textContent = fallback;
};

/**
 * Opens an attendee's record by submitting its ID rather than linking to it.
 *
 * The roster and the lookup do this with a form the template renders; the blank
 * form has no such element, because until the record exists there is nothing to
 * point at. Building one is the same request either way.
 *
 * @param attendeeId - The record to open.
 */
const openRecord = (attendeeId: string): void => {
  const form = document.createElement('form');

  form.method = 'post';
  form.action = '/admin/attendees/edit';

  const field = document.createElement('input');

  field.type = 'hidden';
  field.name = 'attendeeId';
  field.value = attendeeId;

  form.append(field);
  document.body.append(form);
  form.submit();
};

/**
 * Confirmations for the actions on this page that navigate once they succeed.
 *
 * Each of them re-posts the record, which destroys a toast shown beforehand, so
 * the action defers its key and the page it lands on shows it.
 */
const DEFERRED_TOASTS = new Map<string, string>([
  ['attendees:created', FORM_COPY.created],
  ['attendees:archived', FORM_COPY.archived],
  ['attendees:restored', FORM_COPY.restored],
  ['attendees:nicknameRemoved', FORM_COPY.nicknameRemoved],
  ['attendees:checkedIn', FORM_COPY.checkinMarked],
  ['attendees:alreadyCheckedIn', FORM_COPY.checkinAlreadyPresent],
]);

/** Prefix of the deferred key for a new record whose door message was asked. */
const CREATED_WHATSAPP = 'attendees:created:whatsapp:';

/**
 * Every reason a door message may be skipped, so a deferred key read back from
 * storage is checked rather than trusted.
 */
const SKIP_REASONS: readonly DoorSkipReason[] = [
  'lockedByEnv',
  'switchedOff',
  'overBudget',
  'phoneInvalid',
  'rateLimited',
  'alreadySent',
  'attendeeCapReached',
  'attendeeUnavailable',
];

/**
 * The deferred key for a new record, which says what became of its door
 * message as well. One key rather than two toasts, since a toast replaces the
 * one before it.
 *
 * @param whatsapp - The door message's outcome, or `null` when none was asked.
 */
const createdToastKey = (whatsapp: DoorOutcome | null): string => {
  if (whatsapp === null) return 'attendees:created';

  return `${CREATED_WHATSAPP}${whatsapp.status === 'skipped' ? whatsapp.reason : whatsapp.status}`;
};

/**
 * Reads a door message's outcome back out of a deferred key.
 *
 * @param key - The deferred key, as stored.
 * @returns The outcome, or `null` when the key is not one of ours.
 */
const readCreatedOutcome = (key: string): DoorOutcome | null => {
  if (!key.startsWith(CREATED_WHATSAPP)) return null;

  const code = key.slice(CREATED_WHATSAPP.length);

  if (code === 'sent' || code === 'failed') return { status: code };

  const reason = SKIP_REASONS.find((candidate) => candidate === code);

  return reason ? { status: 'skipped', reason } : null;
};

/**
 * Says what became of a door message.
 *
 * Only a sent one is a confirmation. Anything else means the record was saved
 * and somebody still has to hand the attendee their code.
 *
 * @param whatsapp - The outcome.
 * @param context - Which save it rode on.
 * @returns The toast's level and text.
 */
const describeWhatsapp = (
  whatsapp: DoorOutcome,
  context: WhatsappContext,
): { level: ToastLevel; message: string } => {
  const copy = WHATSAPP_COPY[context];

  if (whatsapp.status === 'sent') {
    return { level: 'success', message: copy.sent };
  }

  if (whatsapp.status === 'failed') {
    return { level: 'warn', message: copy.failed };
  }

  return { level: 'info', message: copy.skipped(whatsapp.reason) };
};

/**
 * Shows what became of a door message.
 *
 * @param whatsapp - The outcome.
 * @param context - Which save it rode on.
 */
const showWhatsappToast = (
  whatsapp: DoorOutcome,
  context: WhatsappContext,
): void => {
  const { level, message } = describeWhatsapp(whatsapp, context);

  void toast[level](message);
};

/** Separates a deferred key from the ticket limit warning riding with it. */
const LIMIT_SUFFIX = ';limit=';

/**
 * Adds the ticket limit warning, when one is due, to a deferred key.
 *
 * @param key - The key the action would defer.
 * @param limit - The limit with the new ticket counted, or `null`.
 */
const withExceeded = (
  key: string,
  limit: TicketLimitOverview | null,
): string => {
  const exceeded = encodeExceeded(limit);

  return exceeded === null ? key : `${key}${LIMIT_SUFFIX}${exceeded}`;
};

/**
 * Shows the confirmation the previous page deferred, if it was one of ours,
 * with the ticket limit warning in the same toast when one rode with it.
 */
const showDeferredToast = (): void => {
  const stored = takeDeferredToast();

  if (stored === null) return;

  const [key = '', exceeded] = stored.split(LIMIT_SUFFIX);
  const whatsapp = readCreatedOutcome(key);
  const message = DEFERRED_TOASTS.get(key);
  const figures = exceeded === undefined ? null : decodeExceeded(exceeded);

  let primary: { level: ToastLevel; message: string } | null = null;

  if (whatsapp) primary = describeWhatsapp(whatsapp, 'created');
  else if (message) primary = { level: 'success', message };

  const combined = combineToast(
    primary,
    figures ? limitExceededMessage(figures.used, figures.cap) : null,
  );

  if (combined) {
    void toast[combined.level](combined.message, {
      duration: combined.duration,
    });
  }
};

/** The record form's door message checkbox, when the page rendered one. */
const whatsappBox = (): HTMLInputElement | null =>
  qsOptional<HTMLInputElement>('[data-attendee-whatsapp]');

/**
 * Puts an existing record's checkbox back to rest after a save: unticked, and
 * measuring changes from the number just saved.
 *
 * @param phone - The number as saved.
 */
const resetWhatsapp = (phone: string): void => {
  const box = whatsappBox();

  if (box?.dataset.originalPhone === undefined) return;

  box.dataset.originalPhone = phone;
  box.checked = false;
};

/**
 * Ticks an existing record's checkbox when its number is changed, and unticks
 * it when the change is undone.
 *
 * Only on a record: a blank form's box starts ticked and has no number to
 * compare with. A disabled box is left alone, since it would not be sent.
 */
const setupWhatsappAutoTick = (): void => {
  const box = whatsappBox();
  const phone = qsOptional<HTMLInputElement>('#phone');

  if (!box || !phone || box.dataset.originalPhone === undefined) return;

  phone.addEventListener('input', () => {
    if (box.disabled) return;

    box.checked = phone.value.trim() !== box.dataset.originalPhone?.trim();
  });
};

/**
 * Keeps volunteer-only items out of reach while the role is not volunteer.
 *
 * The server refuses them on a participant regardless; this stops the form
 * offering them. A disabled select is left out of the submission, which the
 * server reads as "not entitled", so switching a volunteer holding one to
 * participant clears it on save. The choice is remembered and restored if the
 * role is switched back first. The blank option is relabelled to match.
 * Absent a role `<select>` — a checked-in record, whose role is locked — the
 * template's rendering is final.
 */
const setupVolunteerOnlyItems = (): void => {
  const role = qsOptional<HTMLSelectElement>('#role');

  if (!role) return;

  const items = document.querySelectorAll<HTMLSelectElement>(
    'select[data-volunteer-only]',
  );
  const remembered = new Map<HTMLSelectElement, string>();

  role.addEventListener('change', () => {
    const blocked = role.value !== 'volunteer';

    for (const select of items) {
      if (blocked && !select.disabled) {
        remembered.set(select, select.value);
        select.value = '';
      } else if (!blocked && select.disabled) {
        select.value = remembered.get(select) ?? '';
      }

      select.disabled = blocked;

      const blank = select.options[0];

      if (blank) {
        blank.textContent =
          blankItemLabel(blocked) === 'unavailable'
            ? FORM_COPY.itemUnavailable
            : FORM_COPY.itemNone;
      }

      const hint = select.parentElement?.querySelector<HTMLElement>(
        '[data-volunteer-only-hint]',
      );

      if (hint) hint.hidden = !blocked;
    }
  });
};

/**
 * Rebuilds the shared items' options when the role changes.
 *
 * Each `select[data-role-options]` carries the approved list of both roles as
 * JSON and the value stored on the record. The blank option is left as
 * rendered, since a collected item has it disabled. What the options and the
 * selection become is decided by `rebuildRoleOptions`.
 *
 * The locked t-shirt submits through a hidden stand-in while its select is
 * disabled, so the stand-in is brought in line, or the save would send the
 * value the select no longer shows. Absent a role `<select>` — a checked-in
 * record — the template's rendering is final.
 */
const setupRoleScopedOptions = (): void => {
  const role = qsOptional<HTMLSelectElement>('#role');

  if (!role) return;

  const renderedRole = role.value;
  const remembered = new Map<HTMLSelectElement, Map<string, string>>();
  let currentRole = renderedRole;

  const selects = [
    ...document.querySelectorAll<HTMLSelectElement>(
      'select[data-role-options]',
    ),
  ];
  const lists = new Map(
    selects.map((select) => [
      select,
      JSON.parse(select.dataset.roleOptions ?? '{}') as Record<
        string,
        string[] | undefined
      >,
    ]),
  );

  role.addEventListener('change', () => {
    const newRole = role.value;

    for (const select of selects) {
      const byRole = remembered.get(select) ?? new Map<string, string>();
      const previous = select.value;

      byRole.set(currentRole, previous);
      remembered.set(select, byRole);

      const result = rebuildRoleOptions({
        options: lists.get(select)?.[newRole] ?? [],
        stored: select.dataset.storedValue ?? '',
        renderedRole,
        newRole,
        previous,
        remembered: byRole.get(newRole),
      });

      const option = (value: string, label: string): HTMLOptionElement => {
        const node = document.createElement('option');

        node.value = value;
        node.textContent = label;

        return node;
      };

      select.replaceChildren(
        ...(select.options[0] ? [select.options[0]] : []),
        ...result.options.map((value) => option(value, value)),
        ...(result.offList === null
          ? []
          : [option(result.offList, itemOffListLabel(result.offList))]),
      );
      select.value = result.selected;

      const standIn = document.querySelector<HTMLInputElement>(
        `input[type="hidden"][data-unlock-stand-in="${select.id}"]`,
      );

      if (standIn) standIn.value = select.value;
    }

    currentRole = newRole;
  });
};

/**
 * Whether the record form holds edits that are not saved.
 *
 * Module-level because the check-in control sits outside the form and must not
 * re-open the record over them: that would discard the edits, and a pending
 * role change would then be refused once the attendee is checked in.
 */
let formDirty = false;

/** Whether the server refused a save because the ticket limit has no room. */
const isLimitRefusal = (err: unknown): boolean =>
  err instanceof ApiError && err.details?.reason === 'ticketLimitReached';

/** The ticket limit banner, inert on a page that rendered none. */
const limitBanner = setupLimitBanner();

/** Wires the save button. */
const setupForm = (): void => {
  const form = qsOptional<HTMLFormElement>('[data-attendee-form]');

  if (!form) return;

  const slot = qsOptional('[data-attendee-error]');
  const button = qsOptional<HTMLButtonElement>('[data-attendee-submit]');
  const attendeeId = form.dataset.attendeeId;

  /**
   * The create's idempotency key, kept across a re-tap after a timeout so the
   * server replays the attendee it already made instead of adding another.
   * Any edit starts a new create: the door-message box counts, since ticking
   * it changes what the create does.
   */
  let pendingKey: string | undefined;

  form.addEventListener('input', () => {
    pendingKey = undefined;
  });

  // `change` as well, for controls that report only that.
  for (const type of ['input', 'change']) {
    form.addEventListener(type, () => {
      formDirty = true;
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    void (async () => {
      if (slot) slot.textContent = '';
      if (button) button.disabled = true;

      try {
        const fields = readFields(form);

        if (attendeeId) {
          const saved = await api.admin.attendees.update(attendeeId, fields);

          if (saved.whatsapp) showWhatsappToast(saved.whatsapp, 'saved');
          else void toast.success(FORM_COPY.saved);

          // The saved number is now the one a change is measured from.
          resetWhatsapp(fields.phone);

          formDirty = false;
        } else {
          pendingKey ??= crypto.randomUUID();

          const created = await api.admin.attendees.create(fields, pendingKey);

          pendingKey = undefined;

          // To the new record rather than back to the roster: the code it was
          // issued is the thing the operator has to read out or write down, and
          // this page shows it in a field where the table buries it in a row.
          //
          // Posted rather than navigated to. The record's address carries no
          // attendee ID any more — a URL is written to the browser's history —
          // so reaching it means submitting one, the same way the roster's edit
          // control does.
          if (created.limit) limitBanner.update(created.limit);

          deferToast(
            withExceeded(createdToastKey(created.whatsapp), created.limit),
          );
          openRecord(created.attendeeId);

          return;
        }
      } catch (err) {
        // Kept only when the outcome is unknown or the server never took it;
        // any other answer means this attempt is finished.
        const retryable =
          err instanceof ApiError &&
          (err.code === 'EDGE_TIMEOUT' || err.code === 'SERVICE_UNAVAILABLE');

        if (!retryable) pendingKey = undefined;

        if (isLimitRefusal(err)) limitBanner.markReached();

        reportError(err, slot);
      }

      if (button) button.disabled = limitBanner.blocked();
    })();
  });
};

/** Wires the nickname removal control. */
const setupNickname = (): void => {
  const button = qsOptional<HTMLButtonElement>('[data-attendee-nickname]');

  if (!button) return;

  const attendeeId = button.dataset.attendeeNickname;

  if (!attendeeId) return;

  button.addEventListener('click', () => {
    void (async () => {
      button.disabled = true;

      try {
        await api.admin.attendees.clearNickname(attendeeId);

        // Posted again rather than reloaded, for the reason the archive control
        // gives: this page was rendered by a POST.
        deferToast('attendees:nicknameRemoved');
        openRecord(attendeeId);
      } catch (err) {
        button.disabled = false;

        reportError(err, qsOptional('[data-attendee-error]'));
      }
    })();
  });
};

/**
 * Wires every `[data-attendee-unlock]` button to the control it names in
 * `aria-controls`, an input or a select that starts disabled.
 *
 * A disabled control is left out of the submission. Where that absence means
 * something (the blank form's ticket code: the server generates one) no
 * stand-in is rendered. Where it would clear a stored value, the template
 * renders the control without a `name`, plus a hidden stand-in carrying the
 * name and the current value; unlocking hands the name over to the control.
 *
 * One-way: an unlocked ticket code left empty still has the server generate
 * one, so there is nothing to lock again.
 */
const setupUnlocks = (): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    'button[data-attendee-unlock]',
  )) {
    const id = button.getAttribute('aria-controls');

    if (!id) continue;

    const control = document.getElementById(id);

    if (!(
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement
    ))
      continue;

    button.addEventListener('click', () => {
      const standIn = document.querySelector<HTMLInputElement>(
        `input[type="hidden"][data-unlock-stand-in="${id}"]`,
      );

      if (standIn) {
        control.name = standIn.name;
        standIn.remove();
      }

      control.disabled = false;
      button.hidden = true;
      control.focus();
    });
  }
};

/** How long the armed archive button waits before it forgets it was clicked. */
const ARM_TIMEOUT_MS = 4000;

/**
 * Wires the danger zone's archive control, and its inverse.
 *
 * A two-step button rather than a native `confirm()` or a modal: the dialog is
 * a jarring interruption for an action this reversible, and a modal is a
 * component this screen would otherwise not need. **Only archiving arms.**
 * Restoring gives a person their check-in back and needs no talking out of.
 *
 * The label changes and the icon never does, for the reason the template gives:
 * `docs/infrastructure/asset-delivery.md` calls the icon set closed and statically provable.
 */
const setupArchive = (): void => {
  const button = qsOptional<HTMLButtonElement>('[data-attendee-archive]');

  if (!button) return;

  const attendeeId = button.dataset.attendeeArchive;

  if (!attendeeId) return;

  const restoring = button.dataset.archived === 'true';
  const label = button.querySelector('.btn-label');

  let armed = false;
  let timer: number | undefined;

  // Asks before the tab is closed or reloaded while archiving is armed. A click
  // that would leave is cancelled by the document handler below instead.
  const unloadGuard = createUnloadGuard();

  /** Puts the button back, including after a confirmed press that failed. */
  const restore = (): void => {
    armed = false;

    window.clearTimeout(timer);
    unloadGuard.release();

    if (label) label.textContent = FORM_COPY.archive;

    button.classList.remove('is-armed');
  };

  const disarm = (): void => {
    if (armed) restore();
  };

  const arm = (): void => {
    armed = true;
    unloadGuard.hold();

    if (label) label.textContent = FORM_COPY.confirm;

    button.classList.add('is-armed');

    window.clearTimeout(timer);
    timer = window.setTimeout(disarm, ARM_TIMEOUT_MS);
  };

  const submit = (): void => {
    // Confirmed, so leaving is no longer losing anything. Released before
    // `openRecord`, which would otherwise prompt for this very action.
    unloadGuard.release();
    window.clearTimeout(timer);
    armed = false;

    void (async () => {
      button.disabled = true;

      try {
        let limit: TicketLimitOverview | null = null;

        if (restoring) {
          limit = await api.admin.attendees.restore(attendeeId);
        } else {
          await api.admin.attendees.archive(attendeeId);
        }

        // Posted again rather than reloaded. This page was rendered by a POST,
        // so `location.reload` asks the browser to resend it and the operator
        // gets a resubmission prompt for an action they already confirmed.
        deferToast(
          restoring
            ? withExceeded('attendees:restored', limit)
            : 'attendees:archived',
        );
        openRecord(attendeeId);

        return;
      } catch (err) {
        if (isLimitRefusal(err)) limitBanner.markReached();

        button.disabled = restoring && limitBanner.blocked();

        restore();

        reportError(
          err,
          qsOptional('[data-attendee-error]'),
          FORM_COPY.actionFailed,
        );
      }
    })();
  };

  button.addEventListener('click', () => {
    if (restoring || armed) {
      submit();

      return;
    }

    arm();
  });

  // An armed button left armed is a click waiting to surprise somebody, so a
  // click anywhere else puts it back. One that would leave the page is
  // cancelled and says so: the operator taps again to leave.
  document.addEventListener('click', (event) => {
    if (
      !armed ||
      (event.target instanceof Node && button.contains(event.target))
    )
      return;

    if (stopLeaving(event)) void toast.warn(leaveNotConfirmedMessage());

    disarm();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') disarm();
  });
};

/**
 * Wires the check-in control, which stands in for the QR scan.
 *
 * Two presses, like the archive control and for the same reason: a check-in
 * draws a number from a sequence and nothing on this page takes it back. The
 * arm/disarm closure is repeated from {@link setupArchive} rather than shared;
 * the two differ in labels and in what confirming does.
 *
 * Refuses to arm while the form has unsaved edits, because confirming re-opens
 * the record from the server.
 */
const setupCheckin = (): void => {
  const button = qsOptional<HTMLButtonElement>('[data-attendee-checkin-mark]');

  if (!button) return;

  const attendeeId = button.dataset.attendeeCheckinMark;

  if (!attendeeId) return;

  const slot = qsOptional('[data-attendee-checkin-error]');
  const label = button.querySelector('.btn-label');

  let armed = false;
  let timer: number | undefined;

  // Asks before the tab is closed or reloaded while check-in is armed. A click
  // that would leave is cancelled by the document handler below instead.
  const unloadGuard = createUnloadGuard();

  /** Puts the button back, including after a confirmed press that failed. */
  const restore = (): void => {
    armed = false;

    window.clearTimeout(timer);
    unloadGuard.release();

    if (label) label.textContent = FORM_COPY.checkinMark;

    button.classList.remove('is-armed');
  };

  const disarm = (): void => {
    if (armed) restore();
  };

  const arm = (): void => {
    armed = true;
    unloadGuard.hold();

    if (label) label.textContent = FORM_COPY.checkinConfirm;

    button.classList.add('is-armed');

    window.clearTimeout(timer);
    timer = window.setTimeout(disarm, ARM_TIMEOUT_MS);
  };

  const submit = (): void => {
    // Confirmed, so leaving is no longer losing anything. Released before
    // `openRecord`, which would otherwise prompt for this very action.
    unloadGuard.release();
    window.clearTimeout(timer);
    armed = false;

    void (async () => {
      button.disabled = true;

      if (slot) slot.textContent = '';

      try {
        const result = await api.admin.lookup.markPresent(attendeeId);

        deferToast(
          result.alreadyCheckedIn
            ? 'attendees:alreadyCheckedIn'
            : 'attendees:checkedIn',
        );
        openRecord(attendeeId);
      } catch (err) {
        button.disabled = false;

        restore();

        reportError(
          err,
          slot,
          FORM_COPY.checkinFailed,
          FORM_COPY.checkinForbidden,
        );
      }
    })();
  };

  button.addEventListener('click', () => {
    if (armed) {
      submit();

      return;
    }

    if (formDirty) {
      if (slot) slot.textContent = FORM_COPY.checkinUnsaved;

      return;
    }

    if (slot) slot.textContent = '';

    arm();
  });

  document.addEventListener('click', (event) => {
    if (
      !armed ||
      (event.target instanceof Node && button.contains(event.target))
    )
      return;

    if (stopLeaving(event)) void toast.warn(leaveNotConfirmedMessage());

    disarm();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') disarm();
  });
};

setupForm();
setupWhatsappAutoTick();
setupVolunteerOnlyItems();
setupRoleScopedOptions();
setupNickname();
setupUnlocks();
setupArchive();
setupCheckin();
showDeferredToast();
