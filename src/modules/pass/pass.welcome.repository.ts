import { env } from '../../config/env.ts';
import pg from '../../shared/db/postgres.ts';

import type { WelcomeScheduleEntry } from '../../config/pass-welcome.ts';

/**
 * Persistence for `pass_welcome_state`, the administrator's welcome schedule.
 * See migration `030`.
 */

/** The event's row, as stored. */
export interface StoredWelcomeState {
  /**
   * The saved list, unchecked: the column holds whatever was written, and the
   * caller decides what to make of it. `null` leaves `.env` in charge.
   */
  schedule: unknown;

  revision: number;
}

/**
 * The event's row.
 *
 * @returns The row, or `null` before the first save.
 */
export const readWelcomeState =
  async (): Promise<StoredWelcomeState | null> => {
    const result = await pg.query<StoredWelcomeState>(
      `SELECT schedule, revision
      FROM pass_welcome_state
      WHERE event_id = $1`,
      [env.eventId],
    );

    return result.rows[0] ?? null;
  };

/**
 * Saves the schedule, or hands back to `.env`, if nobody has saved since
 * `expectedRevision`.
 *
 * One statement for both cases. The update applies only while the row's
 * revision still matches; the insert only when the caller expects no row
 * (`0`) and none exists. A stale caller matches neither and changes nothing.
 * Two saves racing for the same revision serialise on the row lock, and the
 * second re-checks the revision after the first commits; two racing for the
 * first row meet the primary key, and the loser inserts nothing.
 *
 * @param schedule - Entries in ascending order, or `null` for `.env`.
 * @param adminId - `admins.admin_id` of the administrator saving.
 * @param expectedRevision - The revision the caller's page was rendered from;
 *   `0` when it showed no saved schedule.
 * @returns The new revision, or `null` if the row had moved on.
 */
export const writeWelcomeState = async (
  schedule: readonly WelcomeScheduleEntry[] | null,
  adminId: string,
  expectedRevision: number,
): Promise<number | null> => {
  const stored =
    schedule === null
      ? null
      : JSON.stringify(
          schedule.map((entry) => ({
            phase: entry.phase,
            ...(entry.phase === 'custom' ? { text: entry.text } : {}),
            at: new Date(entry.at).toISOString(),
          })),
        );

  const result = await pg.query<{ revision: number }>(
    `WITH updated AS (
      UPDATE pass_welcome_state
      SET schedule = $2::jsonb,
          revision = revision + 1,
          updated_by = $3,
          updated_at = now()
      WHERE event_id = $1 AND revision = $4::integer
      RETURNING revision
    ), inserted AS (
      INSERT INTO pass_welcome_state (event_id, schedule, revision, updated_by)
      SELECT $1, $2::jsonb, 1, $3
      WHERE $4::integer = 0
      ON CONFLICT (event_id) DO NOTHING
      RETURNING revision
    )
    SELECT revision FROM updated
    UNION ALL
    SELECT revision FROM inserted`,
    [env.eventId, stored, adminId, expectedRevision],
  );

  return result.rows[0]?.revision ?? null;
};
