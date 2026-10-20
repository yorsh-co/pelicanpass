import { request } from './api.request.ts';

import type { DoorOverview } from '../../../../types/whatsapp-door.ts';

/**
 * The door message switch on the roster. The panel itself is server-rendered;
 * this is its one write.
 */

/** The response envelope, with everything optional — see api.raffle.ts. */
interface Envelope<T> {
  data?: Partial<T>;
}

/**
 * Turns the door message on or off.
 *
 * @param enabled - The new position.
 * @returns The switch, the spend and the availability as they now stand.
 * @throws {ApiError} `FORBIDDEN` without `whatsapp:send`; `CONFLICT` with
 *   `whatsappDoorLocked` when `.env` locks it off.
 */
export const setSwitch = async (enabled: boolean): Promise<DoorOverview> => {
  const res = await request<Envelope<DoorOverview>>(
    '/api/v1/admin/whatsapp-door/switch',
    {
      method: 'POST',
      json: { enabled },
    },
  );

  const data = res.data;

  if (
    typeof data?.switchOn !== 'boolean' ||
    typeof data.unlocked !== 'boolean' ||
    data.availability === undefined ||
    typeof data.spentUsd !== 'number' ||
    typeof data.budgetUsd !== 'number' ||
    typeof data.priceUsd !== 'number'
  ) {
    throw new Error('Switch returned no overview');
  }

  return {
    unlocked: data.unlocked,
    switchOn: data.switchOn,
    availability: data.availability,
    spentUsd: data.spentUsd,
    budgetUsd: data.budgetUsd,
    priceUsd: data.priceUsd,
  };
};
