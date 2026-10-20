import { request } from './api.request.ts';

import type { RedemptionItem } from '../../../../constants/pass.ts';

/**
 * The volunteer permissions screen's one call. The list and the record are
 * server-rendered, and the record reloads after a save.
 */

/** The seven values a save replaces, in the API's shape. */
export interface VolunteerPermissions {
  canRedeem: boolean;
  redeemScopes: RedemptionItem[];
  canDraw: boolean;
  showAdminLink: boolean;
  team: string | null;
  teamRole: string | null;

  /** `HH:MM`, 24-hour. */
  checkinTime: string | null;
}

/** What a save answers with. */
export interface SaveResult {
  /** The stored values, as the server normalised them. */
  volunteer: VolunteerPermissions;

  /** `false` when the values matched what was stored and nothing was written. */
  changed: boolean;
}

/** The response envelope, with everything optional — see api.raffle.ts. */
interface Envelope<T> {
  data?: Partial<T>;
}

/**
 * Saves a volunteer's permissions.
 *
 * @param attendeeId - Volunteer to change.
 * @param values - All seven values: a save replaces them, so none may be absent.
 * @returns The stored values, and whether the save wrote anything.
 * @throws {ApiError} `VALIDATION_ERROR` for values the server refuses,
 *   `NOT_FOUND` if they are no longer a volunteer of the event, `FORBIDDEN`
 *   without `volunteers:write`.
 */
export const save = async (
  attendeeId: string,
  values: VolunteerPermissions,
): Promise<SaveResult> => {
  const res = await request<Envelope<SaveResult>>(
    `/api/v1/admin/volunteers/${attendeeId}`,
    { method: 'POST', json: values },
  );

  const { volunteer, changed } = res.data ?? {};

  if (!volunteer || typeof changed !== 'boolean') {
    throw new Error('Volunteer save returned no volunteer');
  }

  return { volunteer, changed };
};
