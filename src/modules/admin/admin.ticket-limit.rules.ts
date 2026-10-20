import {
  TICKET_LIMIT_CAP_MAX,
  TICKET_LIMIT_CAP_MIN,
} from '../../constants/ticket-limit.ts';
import { WALK_IN_TICKET_PREFIX } from '../../constants/ticket.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';

import type { AttendeeRole } from '../../types/attendee.ts';
import type {
  TicketLimitMode,
  TicketLimitOverview,
  TicketLimitScope,
  TicketLimitSetting,
  TicketLimitStatus,
} from '../../types/ticket-limit.ts';

/**
 * The decisions behind the ticket limit: which tickets count, what status the
 * count amounts to, when a write is refused, and what a valid setting is.
 *
 * **Pure, and must stay so.** No database, no clock, no environment. The
 * service gathers the facts (the stored setting, the count) and these functions
 * turn them into answers, which is what lets every cell of the rules table be
 * tested without Postgres.
 */

/**
 * Share of the cap, in tenths, from which usage is `near`. Compared as integers
 * (`used * 10 >= cap * 9`) so no rounding can move the boundary.
 */
const NEAR_NUMERATOR = 9;
const NEAR_DENOMINATOR = 10;

const SCOPES: readonly TicketLimitScope[] = ['off', 'total', 'door'];
const MODES: readonly TicketLimitMode[] = ['hard', 'warn'];

/**
 * Whether an attendee counts towards the limit, and so is the kind it can
 * refuse.
 *
 * Volunteers never count and are never blocked, whatever the scope: they are
 * staff, not tickets sold. `total` counts every participant. `door` counts only
 * participants whose code the editor generated, so a code typed by hand, bare or
 * carrying another source's prefix, is neither counted nor blocked in that
 * scope; that gap is accepted and documented in the plan.
 *
 * @param scope - The limit's scope.
 * @param role - The attendee's role.
 * @param ticketCode - The attendee's code, normalised (lowercase).
 */
export const countsTowards = (
  scope: TicketLimitScope,
  role: AttendeeRole,
  ticketCode: string,
): boolean => {
  if (scope === 'off' || role !== 'participant') return false;

  if (scope === 'total') return true;

  return ticketCode.startsWith(WALK_IN_TICKET_PREFIX);
};

/**
 * Classifies usage against a cap.
 *
 * @param cap - The cap, already known to be in range.
 * @param used - Tickets counted.
 */
const statusFor = (cap: number, used: number): TicketLimitStatus => {
  if (used > cap) return 'over';

  if (used === cap) return 'reached';

  return used * NEAR_DENOMINATOR >= cap * NEAR_NUMERATOR ? 'near' : 'ok';
};

/**
 * Combines the stored setting with the current count into what the panel and
 * the form's banner show.
 *
 * A missing row and a row whose scope is `off` are the same state: no limit.
 * The stored cap and mode are still returned for an `off` row so the form can
 * offer them again; with no row at all the cap is null and the mode is `hard`.
 *
 * @param setting - The stored row, or null when none exists.
 * @param used - Tickets counted under the setting's scope.
 */
export const resolveTicketLimit = (
  setting: TicketLimitSetting | null,
  used: number,
): TicketLimitOverview => {
  if (!setting) {
    return {
      scope: 'off',
      cap: null,
      mode: 'hard',
      used,
      remaining: null,
      status: 'off',
    };
  }

  const { scope, cap, mode } = setting;

  if (scope === 'off' || cap === null) {
    return { scope, cap, mode, used, remaining: null, status: 'off' };
  }

  return {
    scope,
    cap,
    mode,
    used,
    remaining: cap - used,
    status: statusFor(cap, used),
  };
};

/**
 * Whether one more counted ticket must be refused.
 *
 * Only a `hard` limit refuses, and only for an attendee that counts: a `warn`
 * limit lets everything through, and an uncounted attendee (a volunteer, or a
 * typed code in `door` scope) does not change the count so it is not blocked by
 * it. The comparison is `used >= cap`, so a limit already `over` keeps refusing.
 *
 * @param overview - The limit as it stands before the write.
 * @param counted - Whether the attendee being written counts towards it.
 */
export const wouldRefuse = (
  overview: TicketLimitOverview,
  counted: boolean,
): boolean =>
  overview.mode === 'hard' &&
  overview.status !== 'off' &&
  counted &&
  overview.cap !== null &&
  overview.used >= overview.cap;

/**
 * Whether a value is a cap the limit can hold. **Strictly a number**: the
 * panel posts JSON, so a numeric string is a client bug, not an input to coerce.
 */
const isCap = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= TICKET_LIMIT_CAP_MIN &&
  value <= TICKET_LIMIT_CAP_MAX;

/**
 * Reads the panel's request body into a setting.
 *
 * Every field is required. The cap must be an integer from
 * {@link TICKET_LIMIT_CAP_MIN} to {@link TICKET_LIMIT_CAP_MAX} unless the scope
 * is `off`, where it may also be null (no cap yet) and a valid integer is kept
 * so the form can offer it again. Numeric strings are refused rather than
 * coerced. Fields are checked in scope, cap, mode order, and the first failure
 * is the one reported.
 *
 * @param body - Parsed request body.
 * @returns The validated setting.
 * @throws {ValidationError} With reason `ticketLimitScope`, `ticketLimitCap` or
 *   `ticketLimitMode`.
 */
export const readTicketLimitInput = (body: unknown): TicketLimitSetting => {
  const input: Record<string, unknown> =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};

  const { scope, cap, mode } = input;

  if (!SCOPES.includes(scope as TicketLimitScope)) {
    throw new ValidationError('Invalid ticket limit scope', {
      reason: 'ticketLimitScope',
    });
  }

  const validScope = scope as TicketLimitScope;

  if (!isCap(cap) && !(validScope === 'off' && cap === null)) {
    throw new ValidationError('Invalid ticket limit cap', {
      reason: 'ticketLimitCap',
    });
  }

  if (!MODES.includes(mode as TicketLimitMode)) {
    throw new ValidationError('Invalid ticket limit mode', {
      reason: 'ticketLimitMode',
    });
  }

  return {
    scope: validScope,
    cap,
    mode: mode as TicketLimitMode,
  };
};
