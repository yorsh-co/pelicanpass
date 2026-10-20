import { randomInt } from 'crypto';

import {
  clearDraw,
  listStandingDraws,
  recordDraw,
} from './raffle.repository.ts';

import { listRaffleNumbers } from '../attendee/attendee.repository.ts';

import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error.ts';

import type { Request, Response } from 'express';

import type {
  RaffleDraw,
  RaffleDrawResult,
  RaffleView,
} from '../../types/raffle.ts';
import type { AttendeeSession } from '../../types/session.ts';

/** Request and response the service acts on. */
interface RaffleServiceParams {
  req: Request;
  res: Response;
}

/**
 * Shape of a `draw_id` coming off the wire.
 *
 * Checked before the value reaches a `uuid` column. Postgres rejects a
 * malformed one with `22P02`, which the error handler has no case for and would
 * serve as a 500 — a client sending nonsense deserves a 400, and an operator
 * looking at the logs deserves to see the difference.
 */
const DRAW_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Operations available to a volunteer permitted to run the draw. */
export class RaffleService {
  readonly req: Request;
  readonly res: Response;
  readonly session: AttendeeSession;

  /**
   * @param params - Request and response for the current call.
   * @throws {Error} If the request carries no attendee session. Every route
   *   that builds this service sits behind `requireSessionType('attendee')`
   *   and `requireDrawPermission`, so this reports a wiring mistake rather than
   *   an unauthorised caller.
   */
  constructor({ req, res }: RaffleServiceParams) {
    const { session } = req;

    if (session?.type !== 'attendee' || !session.attendeeId) {
      throw new Error('RaffleService requires an attendee session');
    }

    this.req = req;
    this.res = res;
    this.session = session;
  }

  /** The operator's own attendee ID, recorded against everything they do. */
  get volunteerId(): string {
    // Narrowed by the constructor; the session type allows null in general.
    return this.session.attendeeId ?? '';
  }

  /**
   * The pool, the counters and the standing draws.
   *
   * Every endpoint returns this rather than a patch, so the page never has to
   * derive a count locally and cannot end up disagreeing with the database
   * about how many numbers are left.
   */
  async view(): Promise<RaffleView> {
    const [pool, standing] = await Promise.all([
      listRaffleNumbers(),
      listStandingDraws(),
    ]);

    return this.#buildView(pool, standing);
  }

  /**
   * Calls one number.
   *
   * The winner is chosen here rather than in SQL. `ORDER BY random() LIMIT 1`
   * would be a round trip fewer, but a draw is the one operation in this
   * application somebody may eventually ask to have explained, and the answer
   * should be a readable line of code rather than a planner's choice.
   *
   * `randomInt` rather than `Math.random()`: it is uniform over the range and
   * free of the modulo bias `Math.floor(Math.random() * n)` carries. The skew
   * is small enough never to be noticed and large enough to be real, and this
   * is a raffle.
   *
   * **A race is accepted here rather than locked out.** The pool read and the
   * insert are not one statement, so two operators drawing in the same instant
   * could each be handed the same number. A draw is run by one person from one
   * phone, and the list this returns refreshes after every call, so a collision
   * would be on screen immediately. An advisory lock — or a single
   * `INSERT … SELECT` straddling the rule that keeps every `attendees`
   * statement in one file — costs more than the failure is worth.
   *
   * @param allowRepeats - Whether numbers already standing may be called again.
   * @returns The number drawn, and the view it left behind.
   * @throws {ConflictError} If nothing is left to draw.
   */
  async draw(allowRepeats: boolean): Promise<RaffleDrawResult> {
    const [pool, standing] = await Promise.all([
      listRaffleNumbers(),
      listStandingDraws(),
    ]);

    const drawn = new Set(standing.map((row) => row.checkin_number));

    const candidates = allowRepeats
      ? pool
      : pool.filter((number) => !drawn.has(number));

    if (candidates.length === 0) {
      throw new ConflictError('No numbers left to draw');
    }

    const winner = candidates[randomInt(candidates.length)];

    // Unreachable: the length check above rules it out, and `randomInt` is
    // exclusive of its bound. `noUncheckedIndexedAccess` cannot see either, and
    // a guard that throws is what this codebase does with an index it has
    // already proven — see `recordDraw`.
    if (winner === undefined) throw new Error('Draw selected nothing');

    const row = await recordDraw(winner, this.volunteerId);

    this.req.log.info(
      {
        checkinNumber: winner,
        volunteerId: this.volunteerId,
        allowRepeats,
        poolSize: pool.length,
      },
      'Raffle number drawn',
    );

    const draw: RaffleDraw = {
      drawId: row.draw_id,
      checkinNumber: row.checkin_number,
      drawnAt: row.created_at,
    };

    // Built from the reads this call already made plus the row it just wrote,
    // rather than re-querying: two more round trips to learn what is already
    // known here, on the one request that has an animation waiting on it.
    return { draw, ...this.#buildView(pool, [row, ...standing]) };
  }

  /**
   * Puts a drawn number back into the pool.
   *
   * @param drawId - The draw to clear.
   * @returns The view the reset left behind.
   * @throws {ValidationError} If `drawId` is not a UUID.
   * @throws {NotFoundError} If no standing draw of this event has that ID —
   *   including one already cleared, which is the same answer from the caller's
   *   point of view: there is nothing there to put back.
   */
  async reset(drawId: string): Promise<RaffleView> {
    if (!DRAW_ID_PATTERN.test(drawId)) {
      throw new ValidationError('Invalid draw');
    }

    if (!(await clearDraw(drawId, this.volunteerId))) {
      throw new NotFoundError('Draw not found');
    }

    this.req.log.info(
      { drawId, volunteerId: this.volunteerId },
      'Raffle number returned to the pool',
    );

    return this.view();
  }

  /**
   * Assembles the view from a pool and the draws standing against it.
   *
   * @param pool - Eligible numbers, ascending.
   * @param standing - Draws not cleared.
   */
  #buildView(
    pool: number[],
    standing: { draw_id: string; checkin_number: number; created_at: Date }[],
  ): RaffleView {
    const drawn = new Set(standing.map((row) => row.checkin_number));

    return {
      draws: standing.map((row) => ({
        drawId: row.draw_id,
        checkinNumber: row.checkin_number,
        drawnAt: row.created_at,
      })),
      poolSize: pool.length,
      remaining: pool.filter((number) => !drawn.has(number)).length,
      // Ascending, so the ends of the array are the ends of the range. Zero on
      // an empty pool: there is no range, and the page has nothing to roll.
      poolMin: pool[0] ?? 0,
      poolMax: pool[pool.length - 1] ?? 0,
    };
  }
}
