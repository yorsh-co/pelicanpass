import { request } from './api.request.ts';

import type {
  TicketLimitOverview,
  TicketLimitSetting,
} from '../../../../types/ticket-limit.ts';

/**
 * The ticket limit panel on the roster. The panel itself is server-rendered;
 * this is its one write.
 */

/** The response envelope, with everything optional — see api.raffle.ts. */
interface Envelope<T> {
  data?: Partial<T>;
}

/**
 * Replaces the ticket limit.
 *
 * A plain setter, safe to repeat, so it carries no idempotency key.
 *
 * @param setting - The scope, the cap and the mode. The cap must be a number,
 *   or `null` when the scope is `off`.
 * @returns The limit as it now stands against the current count.
 * @throws {ApiError} `FORBIDDEN` without `attendees:limit`;
 *   `VALIDATION_ERROR` with `ticketLimitScope`, `ticketLimitCap` or
 *   `ticketLimitMode` when a field is out of range.
 */
export const setLimit = async (
  setting: TicketLimitSetting,
): Promise<TicketLimitOverview> => {
  const res = await request<Envelope<TicketLimitOverview>>(
    '/api/v1/admin/ticket-limit',
    { method: 'POST', json: setting },
  );

  const data = res.data;

  if (
    data?.scope === undefined ||
    data.mode === undefined ||
    data.status === undefined ||
    typeof data.used !== 'number' ||
    data.cap === undefined ||
    data.remaining === undefined
  ) {
    throw new Error('Ticket limit returned no overview');
  }

  return {
    scope: data.scope,
    cap: data.cap,
    mode: data.mode,
    used: data.used,
    remaining: data.remaining,
    status: data.status,
  };
};
