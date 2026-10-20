/**
 * The load-shedding decision, kept free of imports so it can be tested without
 * a configured environment, a pool or a timer.
 *
 * Two signals, decided at different speeds. Event-loop lag is a histogram and
 * can only be read per window, so the sampler in `load.ts` turns it into a flag
 * through {@link nextLoadState}. The pool queue is a number that can be read on
 * every request, so {@link shouldShed} checks it live and refuses only while it
 * is over the limit, rather than everything for as long as a flag is up.
 */

/** A streak machine's state, carried from one tick to the next. */
export interface LoadState {
  overloaded: boolean;
  badStreak: number;
  healthyStreak: number;
}

/**
 * Consecutive bad samples needed to start shedding.
 *
 * One is not enough: a single garbage-collection pause or a burst the pool
 * clears on its own would otherwise start shedding. Two ticks of the sampler is
 * one second of sustained overload.
 */
export const SAMPLES_TO_START = 2;

/**
 * Consecutive healthy samples needed to stop shedding.
 *
 * Longer than {@link SAMPLES_TO_START} on purpose. Shedding empties the pool
 * queue within a tick, so a healthy sample while shedding says little about
 * demand. Stopping after one second let the queue refill within two, and k6
 * measured about ten on/off cycles per raffle draw, each refill a latency spike
 * for the requests let through. Ten ticks is five seconds, the default
 * `Retry-After`.
 */
export const SAMPLES_TO_STOP = 10;

export const INITIAL_LOAD_STATE: LoadState = {
  overloaded: false,
  badStreak: 0,
  healthyStreak: 0,
};

/**
 * Applies one judged sample to a streak machine.
 *
 * The sampler runs two: one decides lag shedding, the other only when to say
 * that shedding of any kind started or stopped. The caller judges the sample,
 * since the two count different things as bad.
 *
 * @param prev - State after the previous sample.
 * @param bad - Whether this sample counts towards starting.
 * @returns The next state, and whether `overloaded` flipped on this sample.
 */
export const nextLoadState = (
  prev: LoadState,
  bad: boolean,
): LoadState & { changed: boolean } => {
  const badStreak = bad ? prev.badStreak + 1 : 0;
  const healthyStreak = bad ? 0 : prev.healthyStreak + 1;

  const overloaded = prev.overloaded
    ? healthyStreak < SAMPLES_TO_STOP
    : badStreak >= SAMPLES_TO_START;

  return {
    overloaded,
    badStreak,
    healthyStreak,
    changed: overloaded !== prev.overloaded,
  };
};

/**
 * Whether one window's worst stall is over the limit. A stall at the limit is
 * healthy.
 *
 * @param lagMs - The window's p99 event-loop delay.
 * @param maxLagMs - `LOAD_SHED_MAX_LAG_MS`.
 */
export const isLagging = (lagMs: number, maxLagMs: number): boolean =>
  lagMs > maxLagMs;

/**
 * Whether to refuse the request in hand.
 *
 * The queue is read live, so only the excess is refused: a request arriving
 * while the queue is over the limit is turned away, and the next one, after a
 * connection has come free, is let through. A queue at the limit is healthy.
 *
 * @param lagShedding - The lag machine's flag.
 * @param poolWaiting - Callers queued for a Postgres connection right now.
 * @param maxPoolWaiting - `LOAD_SHED_MAX_POOL_WAITING`.
 */
export const shouldShed = (
  lagShedding: boolean,
  poolWaiting: number,
  maxPoolWaiting: number,
): boolean => lagShedding || poolWaiting > maxPoolWaiting;

/**
 * Whether a path is never shed.
 *
 * The admin surface is tailnet-only and low volume, and its metrics panel and
 * controls are what an operator needs most while the public surface is being
 * shed. Probes and static files are exempt by being mounted ahead of the
 * middleware, not by this check.
 *
 * Case-insensitive, because Express routes `/ADMIN` to the same handlers as
 * `/admin`.
 *
 * @param path - Request path, without the query string.
 */
export const isShedExempt = (path: string): boolean =>
  /^\/(?:api\/v1\/)?admin(?:\/|$)/i.test(path);
