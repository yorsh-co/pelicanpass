/**
 * A full row of the `raffle_draws` table, in database column casing.
 *
 * Nullability mirrors `migrations/012_raffle-draws.ts`: everything except the
 * two `cleared_*` columns is `NOT NULL`, and those two are null together for as
 * long as the number is still standing.
 *
 * Queries that project a subset of columns should narrow this with `Pick`
 * rather than annotating a partial row as the whole entry.
 */
export interface RaffleDrawEntry {
  draw_id: string;
  event_id: string;

  /** The number that was called. */
  checkin_number: number;

  /** The operating volunteer's `attendee_id`. */
  drawn_by: string;

  created_at: Date;

  /**
   * When the number was put back, or null while it still stands. A reset is a
   * soft clear — the row is never deleted, so the history of what was called
   * and what was returned survives.
   */
  cleared_at: Date | null;

  /** The `attendee_id` of whoever put the number back. */
  cleared_by: string | null;
}

/** One standing draw, in application casing, as the page renders it. */
export interface RaffleDraw {
  drawId: string;
  checkinNumber: number;
  drawnAt: Date;
}

/**
 * Everything the raffle page renders from.
 *
 * Returned whole by all three endpoints rather than patched incrementally on
 * the client: the counters and the list are derived from the same two reads,
 * and a page that recomputed them locally would be one refactor away from
 * disagreeing with the database about how many numbers are left.
 */
export interface RaffleView {
  /** Standing draws, newest first. Cleared ones are not included. */
  draws: RaffleDraw[];

  /** Eligible numbers in total. */
  poolSize: number;

  /** Eligible numbers not currently standing. */
  remaining: number;

  /**
   * The range the pool spans, for the roll animation to cycle within.
   *
   * Sent rather than assumed to be `1..poolSize`: `checkin_number_seq` is
   * global and this repository is reused across events, so a second event's
   * numbers do not start at 1. Both are 0 when the pool is empty.
   */
  poolMin: number;
  poolMax: number;
}

/** The result of one draw: the number called, and the view it left behind. */
export interface RaffleDrawResult extends RaffleView {
  draw: RaffleDraw;
}
