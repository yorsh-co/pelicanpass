import { env } from '../../config/env.ts';
import pg from '../../shared/db/postgres.ts';

import type { RaffleDrawEntry } from '../../types/raffle.ts';

/**
 * Persistence for `raffle_draws`, and for nothing else.
 *
 * The pool of eligible numbers is read by `listRaffleNumbers` in
 * `attendee.repository.ts`: every statement against `attendees` lives in that
 * file, and this module owns only its own table — the same division that keeps
 * `redemptions` in `staff.repository.ts` away from the attendee columns a
 * redemption stamps.
 */

/** Columns every query here projects. */
type DrawRow = Pick<
  RaffleDrawEntry,
  'draw_id' | 'checkin_number' | 'created_at'
>;

/**
 * The draws still standing for this event, newest first.
 *
 * `cleared_at IS NULL` is what makes a reset return a number to the pool: the
 * row survives, and every read simply stops counting it.
 *
 * @returns Standing draws, most recent first.
 */
export const listStandingDraws = async (): Promise<DrawRow[]> => {
  const result = await pg.query<DrawRow>(
    `SELECT
      draw_id,
      checkin_number,
      created_at
    FROM raffle_draws
    WHERE event_id = $1
      AND cleared_at IS NULL
    ORDER BY created_at DESC`,
    [env.eventId],
  );

  return result.rows;
};

/**
 * Records that a number was called.
 *
 * `RETURNING` works here where the redemption insert could not use it: this
 * table grants `SELECT` as well as `INSERT`, because the page reads its own
 * list back on every load.
 *
 * @param checkinNumber - The number drawn.
 * @param drawnBy - The operating volunteer's attendee ID.
 * @returns The row as stored, including the server's own timestamp.
 * @throws {Error} If the insert returns nothing, which cannot happen for a
 *   single-row insert and would mean the statement is no longer what it says.
 */
export const recordDraw = async (
  checkinNumber: number,
  drawnBy: string,
): Promise<DrawRow> => {
  const result = await pg.query<DrawRow>(
    `INSERT INTO raffle_draws (event_id, checkin_number, drawn_by)
    VALUES ($1, $2, $3)
    RETURNING draw_id, checkin_number, created_at`,
    [env.eventId, checkinNumber, drawnBy],
  );

  const row = result.rows[0];
  if (!row) throw new Error('Draw insert returned no row');

  return row;
};

/**
 * Puts a drawn number back into the pool.
 *
 * A conditional update rather than a delete: the application holds no `DELETE`
 * on this table at all, so the row stays and `cleared_at` is what takes it out
 * of every read. The history of a number being called and returned is worth
 * more than the row is worth removing.
 *
 * `cleared_at IS NULL` in the predicate makes this idempotent in the direction
 * that matters — a second reset of the same draw matches nothing rather than
 * overwriting who returned it and when.
 *
 * @param drawId - The draw to clear.
 * @param clearedBy - The attendee ID of whoever is putting it back.
 * @returns Whether a standing draw was found and cleared.
 */
export const clearDraw = async (
  drawId: string,
  clearedBy: string,
): Promise<boolean> => {
  const result = await pg.query(
    `UPDATE raffle_draws
    SET cleared_at = now(),
        cleared_by = $3
    WHERE draw_id = $1
      AND event_id = $2
      AND cleared_at IS NULL`,
    [drawId, env.eventId, clearedBy],
  );

  return result.rowCount === 1;
};
