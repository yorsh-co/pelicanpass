import { LABEL_MAX_LENGTH, parseCheckinTime } from './admin.attendees.rules.ts';
import { ITEM_ORDER } from './admin.volunteer-permissions.import.ts';
import { isRedemptionItem } from '../../constants/pass.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';

import type { RedemptionItem } from '../../constants/pass.ts';

/**
 * The rules a volunteer's permissions are held to when an administrator saves
 * them.
 *
 * **Pure, and must stay so**, like `admin.redemptions.rules.ts`. Every message
 * here is fixed and names no input: the body carries a team label typed by a
 * person, and an error that echoed it would put it in a response and a log.
 */

/** The seven values `set_volunteer_permissions` takes, in the API's shape. */
export interface VolunteerPermissions {
  canRedeem: boolean;

  /** In {@link REDEEMABLE_ITEMS} order, without repeats. */
  redeemScopes: RedemptionItem[];

  canDraw: boolean;
  showAdminLink: boolean;
  team: string | null;
  teamRole: string | null;

  /** `HH:MM`, 24-hour; `null` while unset. */
  checkinTime: string | null;
}

/** The one refusal every rule below raises. */
const invalid = (): ValidationError =>
  new ValidationError('Invalid volunteer permissions');

/**
 * Reads a strict boolean field.
 *
 * @throws {ValidationError} If the field is absent or not a boolean.
 */
const readFlag = (record: Record<string, unknown>, field: string): boolean => {
  const value = record[field];

  if (typeof value !== 'boolean') throw invalid();

  return value;
};

/**
 * Reads a label: trimmed, with blank meaning none.
 *
 * Length is counted in code points, as the column's `char_length` check does,
 * so a label the database accepts is never refused here and vice versa.
 *
 * @throws {ValidationError} If the field is not a string or `null`, or is too
 *   long.
 */
const readLabel = (
  record: Record<string, unknown>,
  field: string,
): string | null => {
  const value = record[field];

  if (value === null) return null;

  if (typeof value !== 'string') throw invalid();

  const label = value.trim();

  if (label === '') return null;

  if (Array.from(label).length > LABEL_MAX_LENGTH) throw invalid();

  return label;
};

/**
 * Reads a clock time: `HH:MM` or `H:MM`, with blank meaning none.
 *
 * @returns The time as `HH:MM`, or `null`.
 * @throws {ValidationError} If the field is not a string or `null`, or is not
 *   a 24-hour time of whole minutes.
 */
const readTime = (
  record: Record<string, unknown>,
  field: string,
): string | null => {
  const value = record[field];

  if (value === null) return null;

  if (typeof value !== 'string') throw invalid();

  if (value.trim() === '') return null;

  const time = parseCheckinTime(value);

  if (time === null) throw invalid();

  return time;
};

/**
 * Reads the stations: known items only, de-duplicated and in storage order.
 *
 * An empty list is valid, and `canRedeem` with no stations is allowed: it
 * grants nothing, as `redeemScopes` in `permission.middleware.ts` explains.
 *
 * @throws {ValidationError} If the field is not an array of known items.
 */
const readScopes = (record: Record<string, unknown>): RedemptionItem[] => {
  const value = record.redeemScopes;

  if (
    !Array.isArray(value) ||
    !value.every(
      (item): item is RedemptionItem =>
        typeof item === 'string' && isRedemptionItem(item),
    )
  ) {
    throw invalid();
  }

  return ITEM_ORDER.filter((item) => value.includes(item));
};

/**
 * Parses the body of a permissions save.
 *
 * Every field is required: a save replaces all seven, so an absent one cannot be
 * told from an instruction to clear it. Unknown keys are ignored, as the
 * correction body's are.
 *
 * @param body - Parsed request body, or whatever Express left in its place.
 * @returns The seven values, normalised.
 * @throws {ValidationError} With a fixed message that names no input.
 */
export const readVolunteerPermissions = (
  body: unknown,
): VolunteerPermissions => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid();
  }

  const record = body as Record<string, unknown>;

  return {
    canRedeem: readFlag(record, 'canRedeem'),
    redeemScopes: readScopes(record),
    canDraw: readFlag(record, 'canDraw'),
    showAdminLink: readFlag(record, 'showAdminLink'),
    team: readLabel(record, 'team'),
    teamRole: readLabel(record, 'teamRole'),
    checkinTime: readTime(record, 'checkinTime'),
  };
};
