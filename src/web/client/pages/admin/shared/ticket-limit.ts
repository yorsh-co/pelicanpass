import { WALK_IN_TICKET_PREFIX } from '../../../../../constants/ticket.ts';

import type {
  TicketLimitMode,
  TicketLimitOverview,
  TicketLimitScope,
  TicketLimitStatus,
} from '../../../../../types/ticket-limit.ts';

/**
 * The ticket limit's decisions as the admin pages need them: would a save be
 * counted, would it be refused, how full is the meter, and how an overview
 * travels as an attribute or a deferred toast key.
 *
 * Pure and DOM-free so it can be tested under Node. The server stays the
 * authority: `admin.ticket-limit.rules.ts` makes the real decisions, and this
 * module only predicts them so the form can say so before the request is made.
 * `ticket-limit.test.ts` pins the two together.
 */

const SCOPES: readonly TicketLimitScope[] = ['off', 'total', 'door'];
const MODES: readonly TicketLimitMode[] = ['hard', 'warn'];
const STATUSES: readonly TicketLimitStatus[] = [
  'off',
  'ok',
  'near',
  'reached',
  'over',
];

/** Whether an untrusted value is one of a closed set of strings. */
const isOneOf = (set: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && set.includes(value);

/**
 * Reads an overview out of a `data-` attribute or an API payload.
 *
 * @param raw - JSON text, or `undefined` when the attribute is absent.
 * @returns The overview, or `null` when it is absent or malformed. A page then
 *   draws nothing rather than a wrong number.
 */
export const parseOverview = (
  raw: string | undefined,
): TicketLimitOverview | null => {
  if (!raw) return null;

  try {
    const value = JSON.parse(raw) as Partial<TicketLimitOverview> | null;

    if (
      value === null ||
      typeof value !== 'object' ||
      !isOneOf(SCOPES, value.scope) ||
      !isOneOf(MODES, value.mode) ||
      !isOneOf(STATUSES, value.status) ||
      typeof value.used !== 'number' ||
      (value.cap !== null && typeof value.cap !== 'number') ||
      (value.remaining !== null && typeof value.remaining !== 'number')
    ) {
      return null;
    }

    return value as TicketLimitOverview;
  } catch {
    return null;
  }
};

/**
 * Whether a participant ticket would count towards the limit.
 *
 * Volunteers never count. `total` counts every participant. `door` counts a
 * participant whose code is generated (blank field) or starts `d`, which is
 * what the server tests against the code it actually inserts.
 *
 * @param scope - The limit's scope.
 * @param role - The role chosen on the form.
 * @param ticketCode - The code field as typed; blank asks for a generated one.
 */
export const wouldCount = (
  scope: TicketLimitScope,
  role: string,
  ticketCode: string,
): boolean => {
  if (scope === 'off' || role !== 'participant') return false;

  if (scope === 'total') return true;

  const code = ticketCode.trim().toLowerCase();

  return code === '' || code.startsWith(WALK_IN_TICKET_PREFIX);
};

/**
 * Whether a hard limit with no room left would refuse this save.
 *
 * @param overview - The limit as the page last knew it, or `null` for none.
 * @param role - The role chosen on the form.
 * @param ticketCode - The code field as typed.
 */
export const wouldBlock = (
  overview: TicketLimitOverview | null,
  role: string,
  ticketCode: string,
): boolean =>
  overview !== null &&
  overview.mode === 'hard' &&
  (overview.status === 'reached' || overview.status === 'over') &&
  wouldCount(overview.scope, role, ticketCode);

/**
 * The limit after the server has refused a save for lack of room.
 *
 * A hard refusal proves the count is at least the cap, whatever the page was
 * rendered with. Attendees writers have no read endpoint for the count, by
 * design, so this is the only fresher figure the form can have. Used is raised
 * to the cap, never lowered, so an overview that is already over keeps its
 * excess.
 *
 * @param overview - The limit as the page last knew it.
 * @returns The overview with the cap taken as reached; unchanged when the
 *   limit is off or has no cap.
 */
export const assumeReached = (
  overview: TicketLimitOverview,
): TicketLimitOverview => {
  if (overview.status === 'off' || overview.cap === null) return overview;

  const used = Math.max(overview.used, overview.cap);

  return {
    ...overview,
    used,
    remaining: overview.cap - used,
    status: used > overview.cap ? 'over' : 'reached',
  };
};

/**
 * Whether a warn-mode limit has been reached, which is when a create or a
 * restore says so in a toast.
 *
 * @param overview - The limit with the new ticket counted, or `null`.
 */
export const isExceeded = (overview: TicketLimitOverview | null): boolean =>
  overview !== null &&
  overview.mode === 'warn' &&
  (overview.status === 'reached' || overview.status === 'over');

/**
 * How much of the meter to fill: used over cap, clamped to the bar.
 *
 * @param overview - The limit.
 * @returns A fraction from 0 to 1; 0 when there is no cap.
 */
export const meterFill = (overview: TicketLimitOverview): number =>
  overview.cap === null || overview.cap <= 0
    ? 0
    : Math.min(Math.max(overview.used / overview.cap, 0), 1);

/** `aria-valuenow`: usage, held at the cap so the bar never reads past full. */
export const meterNow = (overview: TicketLimitOverview): number =>
  overview.cap === null ? 0 : Math.min(overview.used, overview.cap);

/** Tickets above the cap, never negative. */
export const excessOf = (overview: TicketLimitOverview): number =>
  overview.cap === null ? 0 : Math.max(0, overview.used - overview.cap);

/** Tickets still available under the cap, never negative. */
export const remainingOf = (overview: TicketLimitOverview): number =>
  overview.cap === null ? 0 : Math.max(0, overview.cap - overview.used);

/**
 * Encodes a warn-mode overview into a deferred toast key suffix, so the next
 * page can say "51 / 50" without anything else being stored.
 *
 * @param overview - The limit with the new ticket counted, or `null`.
 * @returns `used/cap` when the toast is due, otherwise `null`.
 */
export const encodeExceeded = (
  overview: TicketLimitOverview | null,
): string | null =>
  overview !== null && isExceeded(overview) && overview.cap !== null
    ? `${String(overview.used)}/${String(overview.cap)}`
    : null;

/**
 * Reads {@link encodeExceeded}'s output back.
 *
 * @param raw - The suffix as stored.
 * @returns The figures, or `null` when it is not ours.
 */
export const decodeExceeded = (
  raw: string,
): { used: number; cap: number } | null => {
  const match = /^(\d{1,9})\/(\d{1,9})$/.exec(raw);

  return match ? { used: Number(match[1]), cap: Number(match[2]) } : null;
};
