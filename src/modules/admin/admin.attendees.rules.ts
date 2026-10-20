import { isApprovedOption } from './admin.item-options.ts';

import {
  VOLUNTEER_TICKET_PREFIX,
  isValidTicketCode,
} from '../../constants/ticket.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';

import type { RedemptionItem } from '../../constants/pass.ts';
import type { AttendeeRole } from '../../types/attendee.ts';

/**
 * The field rules an attendee record is held to, wherever it is written from.
 *
 * Shared by the administrator's editor (`admin.attendees.service.ts`) and the
 * roster import (`scripts/db/import-attendees.ts`), so a row cannot be valid
 * through one and refused by the other.
 *
 * **Pure, and must stay so.** The import runs as a CLI script with only the
 * migrator's credentials in its environment; anything here that reached
 * `config/env.ts` or a connection pool would make it unimportable there.
 */

/** Longest name accepted. The roster's longest today is 21 characters. */
const NAME_MAX_LENGTH = 120;

/**
 * Digits a phone number must carry.
 *
 * The floor is not a formatting preference. `verifyAttendee` compares
 * `attendee_phone.slice(-4)` through `timingSafeEqual`, whose own comment notes
 * that a stored number shorter than four digits makes the lengths disagree and
 * throw — so a short number is not a cosmetic problem, it is a door that stops
 * opening. Ten is a Brazilian area code plus eight digits; fifteen is E.164's
 * ceiling, which admits a `55` country code on an eleven-digit mobile.
 */
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 15;

/** Any run of whitespace, including the non-breaking and ideographic kinds. */
const WHITESPACE_RUN_RE = /\s+/gu;

/** Control, format and unassigned code points. */
const CONTROL_AND_FORMAT_RE = /\p{C}/gu;

/** At least one letter, so `--` and `1234` do not pass as a name. */
const HAS_LETTER_RE = /\p{L}/u;

/**
 * Reduces a typed name to the exact string that would be stored.
 *
 * **These four steps, in this order, are `normaliseNickname`'s**, and the
 * duplication is deliberate. That function calls the control-and-format strip
 * "the security-relevant step, not a tidying one": it removes zero-width
 * padding, which is invisible characters that defeat a length limit and make
 * two different values render identically, and the bidirectional overrides,
 * which reverse the rendering of everything after them so a stored string can
 * display as something other than what it is. All of that applies at least as
 * hard to a name an administrator types, which is listed in a roster table and
 * reaches `maskName` on the check-in preview.
 *
 * Whitespace is collapsed *before* the control strip so a tab becomes a word
 * gap rather than vanishing and joining two words together.
 *
 * @param raw - Value as received from the request body.
 */
const normaliseAttendeeName = (raw: string): string =>
  raw
    .normalize('NFC')
    .replace(WHITESPACE_RUN_RE, ' ')
    .replace(CONTROL_AND_FORMAT_RE, '')
    .trim();

/**
 * Normalises and checks an attendee's name.
 *
 * @param raw - Value as received.
 * @throws {ValidationError} If it is empty, overlong or carries no letter.
 */
export const readName = (raw: string): string => {
  const name = normaliseAttendeeName(raw);

  if (!name || name.length > NAME_MAX_LENGTH || !HAS_LETTER_RE.test(name)) {
    throw new ValidationError('Invalid name', { reason: 'nameInvalid' });
  }

  return name;
};

/**
 * Reduces a typed phone number to the value that gets stored.
 *
 * That is the digits alone, or the digits behind a `+` when the input starts
 * with one. The `+` is kept because it marks the number as already carrying its
 * country code, so the WhatsApp sender does not prepend the default one.
 *
 * @param raw - Value as received, punctuation and all.
 * @throws {ValidationError} If it carries too few or too many digits.
 */
export const readPhone = (raw: string): string => {
  const digits = raw.replace(/\D/g, '');

  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) {
    throw new ValidationError('Invalid phone', { reason: 'phoneInvalid' });
  }

  return raw.trim().startsWith('+') ? `+${digits}` : digits;
};

/**
 * Narrows an unchecked role.
 *
 * @param raw - Value as received.
 * @throws {ValidationError} If it is neither role.
 */
export const readRole = (raw: string | undefined): AttendeeRole => {
  if (raw !== 'participant' && raw !== 'volunteer') {
    throw new ValidationError('Invalid role', { reason: 'roleInvalid' });
  }

  return raw;
};

/**
 * Checks a code the operator typed, and that it agrees with the chosen role.
 *
 * The code pins the role: a `v` key is a volunteer, and every other key is a
 * participant — `d` from the editor, any other letter or digit from the
 * external sign-up system.
 *
 * @param raw - Value as received.
 * @param role - Role chosen on the form.
 * @throws {ValidationError} If the shape is wrong, or the prefix and the role
 *   disagree.
 */
export const readTypedTicketCode = (
  raw: string,
  role: AttendeeRole,
): string => {
  const code = raw.trim().toLowerCase();

  if (!isValidTicketCode(code)) {
    throw new ValidationError('Invalid ticket code', {
      reason: 'ticketCodeFormat',
    });
  }

  const isVolunteerCode = code.startsWith(VOLUNTEER_TICKET_PREFIX);

  if (isVolunteerCode !== (role === 'volunteer')) {
    throw new ValidationError('Ticket code prefix does not match the role', {
      reason: 'ticketCodePrefix',
    });
  }

  return code;
};

/** Columns holding a free-text label rather than a flag or a scope list. */
export type LabelField = 'team' | 'team_role';

/** Longest `team` or `team_role`, matching the check in migration 024. */
export const LABEL_MAX_LENGTH = 40;

/** Accepts `H:MM` and `HH:MM`, 24-hour, whole minutes. */
const CHECKIN_TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Reads a `team` or `team_role` cell. Case is kept as typed: it is shown on
 * the pass exactly as written.
 *
 * @param column - Column name, for the message.
 * @param value - The trimmed cell.
 * @returns The label with inner whitespace collapsed, or `null` for a blank
 *   cell, which clears it.
 * @throws {Error} If it is longer than {@link LABEL_MAX_LENGTH}.
 */
export const readLabel = (column: LabelField, value: string): string | null => {
  const label = value.replace(/\s+/g, ' ');

  if (label === '') return null;

  if (label.length > LABEL_MAX_LENGTH) {
    throw new Error(
      `${column} must be at most ${String(LABEL_MAX_LENGTH)} characters`,
    );
  }

  return label;
};

/**
 * Normalises a clock time to `HH:MM`.
 *
 * @param value - `H:MM` or `HH:MM`, 24-hour, surrounding whitespace allowed.
 * @returns The zero-padded time, or `null` if the text is not one.
 */
export const parseCheckinTime = (value: string): string | null => {
  const match = CHECKIN_TIME_PATTERN.exec(value.trim());

  return match
    ? `${(match[1] ?? '').padStart(2, '0')}:${match[2] ?? ''}`
    : null;
};

/**
 * Reads a `checkin_time` cell.
 *
 * @param value - The trimmed cell.
 * @returns The time as `HH:MM`, or `null` for a blank cell, which clears it.
 * @throws {Error} If it is not a 24-hour `H:MM` or `HH:MM` time.
 */
export const readCheckinTime = (value: string): string | null => {
  if (value === '') return null;

  const time = parseCheckinTime(value);

  if (time === null) throw new Error('checkin_time must be a time as HH:MM');

  return time;
};

/** An entitlement as stored, with the role its holder had when it was stored. */
export interface StoredOption {
  readonly value: string | null;
  readonly role: AttendeeRole;
}

/**
 * Reads one entitlement, where empty means "not entitled".
 *
 * A value must be on the approved list for the role, **or be the one already
 * stored under the same role**. The roster is imported outside this application
 * and can carry values the list does not, and refusing those would make the
 * record unsaveable until somebody changed an entitlement they never meant to
 * touch. A role change ends the exemption: the lists differ per role, so the
 * stored value was never vetted for the new one.
 *
 * @param raw - Value as received, or undefined if the body omitted it.
 * @param item - The entitlement it is for, named in the refusal.
 * @param role - The role the record will have once saved.
 * @param current - The value and role as stored, or `null` when creating.
 * @throws {ValidationError} If it is not approved and not an unchanged value.
 */
export const readOption = (
  raw: string | undefined,
  item: RedemptionItem,
  role: AttendeeRole,
  current: StoredOption | null,
): string | null => {
  const value = (raw ?? '').trim();

  if (value === '') return null;

  const unchanged =
    current !== null && current.role === role && current.value === value;

  if (!unchanged && !isApprovedOption(item, value, role)) {
    throw new ValidationError(`Option not approved: ${item}`, {
      reason: 'optionNotAllowed',
      item,
    });
  }

  return value;
};

/**
 * Reads an entitlement only a volunteer may hold.
 *
 * Refused here with a readable reason rather than left to the item's
 * `attendees_*_volunteer_check`, whose violation would reach the operator as a
 * generic failure. Changing a volunteer holding one to a participant is
 * therefore two steps: clear the item, then change the role — and a collected
 * item cannot be cleared at all.
 *
 * @param raw - Value as received, or undefined if the body omitted it.
 * @param item - The entitlement it is for, named in the refusal.
 * @param role - The role the record will have once saved.
 * @param current - The value and role as stored, or `null` when creating.
 * @throws {ValidationError} If it is set on a participant, which is checked
 *   first so the refusal names the real cause, or is not approved and not an
 *   unchanged value.
 */
export const readVolunteerOnlyOption = (
  raw: string | undefined,
  item: RedemptionItem,
  role: AttendeeRole,
  current: StoredOption | null,
): string | null => {
  if ((raw ?? '').trim() !== '' && role !== 'volunteer') {
    throw new ValidationError(`Volunteer-only item: ${item}`, {
      reason: 'volunteerOnlyItem',
      item,
    });
  }

  return readOption(raw, item, role, current);
};
