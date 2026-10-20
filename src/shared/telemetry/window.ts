/**
 * A fixed-size, in-process counter over the last hour, in one-minute buckets.
 *
 * Deliberately not Redis-backed, and that is the whole point of the module.
 * "Redis is unreachable" is one of the conditions the alert rules have to fire
 * on, so the data those rules read cannot live in Redis — with
 * `enableOfflineQueue: false` and `commandTimeout: 1000` (`shared/db/redis.ts`)
 * a read during an outage throws into the evaluation loop rather than returning
 * a stale number. This mirrors the `RateLimiterMemory` insurance tier
 * `rate.middleware.ts` already keeps for the same reason.
 *
 * The Redis counters added later serve the **dashboard**, which wants an hour of
 * history that survives a container recreate. These two are not duplicates: the
 * dashboard wants durability, the alert loop wants availability through exactly
 * the outage the dashboard cannot survive.
 *
 * Costs 60 int32s plus 60 float64s per series — under a kilobyte each, with no
 * allocation on the hot path. The process is a single container, so an
 * in-process count is the true count rather than one shard of it.
 */

const WINDOW_MINUTES = 60;

interface Series {
  /** Count per slot. Index is `absoluteMinute % WINDOW_MINUTES`. */
  readonly counts: Int32Array;
  /**
   * Which absolute minute each slot currently holds. Without this a slot read
   * an hour later would return a stale count as if it were current; comparing
   * the stamp is what makes the ring self-expiring with no sweep.
   */
  readonly stamps: Float64Array;
}

const series = new Map<string, Series>();

const currentMinute = (): number => Math.floor(Date.now() / 60_000);

const slotOf = (minute: number): number =>
  ((minute % WINDOW_MINUTES) + WINDOW_MINUTES) % WINDOW_MINUTES;

const ensure = (name: string): Series => {
  const existing = series.get(name);

  if (existing) return existing;

  const created: Series = {
    counts: new Int32Array(WINDOW_MINUTES),
    // -1 rather than 0, so slot 0 is not mistaken for holding minute 0 of the
    // epoch before anything has been written to it.
    stamps: new Float64Array(WINDOW_MINUTES).fill(-1),
  };

  series.set(name, created);

  return created;
};

/**
 * Records one occurrence of a counter in the current minute.
 *
 * @param name - Counter name, e.g. `http.5xx`.
 * @param by - Amount to add. Defaults to 1.
 */
export const bump = (name: string, by = 1): void => {
  const minute = currentMinute();
  const target = ensure(name);
  const slot = slotOf(minute);

  // A slot holding a different minute is an hour stale; claim it rather than
  // adding to a count from the previous lap.
  if (target.stamps[slot] !== minute) {
    target.stamps[slot] = minute;
    target.counts[slot] = 0;
  }

  // `?? 0` rather than a non-null assertion: `noUncheckedIndexedAccess` is on,
  // and the slot is provably in range, so the fallback is unreachable — but
  // spelling it costs nothing and the assertion would have to be justified.
  target.counts[slot] = (target.counts[slot] ?? 0) + by;
};

/**
 * Sums a counter over the most recent whole minutes, current minute included.
 *
 * @param name - Counter name.
 * @param minutes - How many minutes back to sum. Clamped to the window size.
 * @returns The total, or 0 for a counter that has never been bumped.
 */
export const total = (name: string, minutes: number): number => {
  const target = series.get(name);

  if (!target) return 0;

  const now = currentMinute();
  const span = Math.min(Math.max(minutes, 1), WINDOW_MINUTES);
  let sum = 0;

  for (let back = 0; back < span; back++) {
    const minute = now - back;
    const slot = slotOf(minute);

    if (target.stamps[slot] === minute) sum += target.counts[slot] ?? 0;
  }

  return sum;
};

/**
 * Average per-minute rate of a counter over a span.
 *
 * @param name - Counter name.
 * @param minutes - Span to average over. Defaults to 1.
 */
export const ratePerMinute = (name: string, minutes = 1): number =>
  total(name, minutes) / Math.min(Math.max(minutes, 1), WINDOW_MINUTES);
