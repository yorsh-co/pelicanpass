import { ApiError } from '../../core/api/api.error.ts';
import { logger } from '../log/logger.ts';

import { BAND_RETRY_MS } from './pacing.ts';

/**
 * Polls an endpoint on a fixed cadence and reports whether it is keeping up.
 *
 * **Sibling to `startBandLoop`, deliberately, not a generalisation of it.** That
 * loop schedules each refresh from the server's own `expiresInMs` so it tracks a
 * rotation window instead of drifting against it, its payload type requires a
 * band, and its grace period is tuned to the gap at a window boundary. None of
 * that describes a dashboard, which wants a fixed five seconds and has no window
 * at all — using it here would mean every snapshot carrying a fabricated band
 * and a fake expiry to satisfy the type.
 *
 * It is also load-bearing for two screens whose whole mechanism is that they run
 * identical code: the attendee's pass and the volunteer's band agree because
 * neither was told what the other shows. Widening it for a third, differently
 * shaped caller would put that at risk to save these sixty lines.
 *
 * What is shared is the part worth sharing — the `live | pending | stale`
 * vocabulary, the single-flight guard, the `visibilitychange` handling, and
 * `BAND_RETRY_MS`. A laptop that gets locked throttles its timers exactly like a
 * phone that does, and a dashboard showing frozen numbers as though they were
 * live is worse than one showing nothing.
 */

/** What the screen is showing. Same three states, same reasons. */
export type PollState = 'live' | 'pending' | 'stale';

/** Everything the loop needs to poll something and report on it. */
export interface PollLoopParams<T> {
  /** Fetches the next payload. A `null` counts as a failed refresh. */
  fetch: () => Promise<T | null>;

  /** Paints whatever the response carries. */
  render: (payload: T) => void;

  /** Paints the live/pending/stale cover. */
  setState: (state: PollState) => void;

  /**
   * Redraws the countdown to the next refresh, once a second.
   *
   * A separate timer from the refresh, and the split is the same one
   * `startBandLoop` makes: the clock touches nothing but the DOM, so it must
   * not be coupled to the network.
   *
   * **This is why the liveness indicator is a countdown and not a pulse.** A
   * CSS animation would be capped to `0.01ms` with a single iteration by the
   * reduced-motion block in `base/reset.css`, leaving the indicator silently
   * dead for the users least likely to report it — the trap
   * `components/window-ring.css` already writes down for its own arc. Stepping
   * a number from a clock is visible to everybody.
   */
  tick: (remainingMs: number, fraction: number) => void;

  /** How often to poll, in milliseconds. */
  intervalMs: number;
}

/** The handle a page drives the loop with. */
export interface PollLoop {
  /** Fetch now at the user's request, resolving once the attempt has settled. */
  retry: () => Promise<void>;

  /** Stop scheduling. */
  suspend: () => void;
}

/**
 * How long past a due refresh the screen still reads as merely `pending`.
 *
 * Two intervals: one missed poll is a slow round trip, two is a screen that has
 * stopped tracking. Below this the numbers on screen are old enough to notice
 * and new enough to trust.
 */
const STALE_AFTER_INTERVALS = 2;

/**
 * Starts polling.
 *
 * @param params - The fetch, the paint callbacks and the cadence.
 * @returns The handle for a retry button and for teardown.
 */
export const startPollLoop = <T>({
  fetch,
  render,
  setState,
  tick,
  intervalMs,
}: PollLoopParams<T>): PollLoop => {
  let timer: number | undefined;
  let inFlight = false;

  /**
   * Whether the loop is still running at all.
   *
   * Not "is the tab visible" — a hidden tab keeps this true and only drops its
   * pending timeout. It goes false once, from `standDown`, and nothing sets it
   * back: both the caller's `suspend` and a challenged edge are one-way.
   */
  let showing = true;

  /** When the last successful payload landed. */
  let landedAt = performance.now();

  /** When the next refresh is due, for the countdown. */
  let nextAt = performance.now() + intervalMs;

  const pollState = (): PollState => {
    const age = performance.now() - landedAt;

    if (age <= intervalMs) return 'live';

    return age > intervalMs * STALE_AFTER_INTERVALS ? 'stale' : 'pending';
  };

  const schedule = (delay: number): void => {
    window.clearTimeout(timer);

    if (!showing) return;

    nextAt = performance.now() + delay;
    timer = window.setTimeout(() => void refresh(), delay);
  };

  /**
   * Reports the time to the next refresh, and how much of the interval is left
   * as a 0–1 fraction for the arc.
   *
   * Clamped at zero rather than going negative: a countdown that sits at zero
   * says "the refresh is late", which is true and readable. One counting
   * downward past zero says nothing anybody wants to read at 20:00.
   */
  const drawTick = (): void => {
    // State first, then the clock. The countdown's wording depends on whether
    // refreshes are landing — "próxima em 3 s" and "nova tentativa em 3 s" are
    // the same number and opposite meanings — so `tick` has to run against the
    // current verdict rather than the previous second's.
    //
    // This is also the cheapest place to notice that a refresh never landed: a
    // throttled tab wakes here before its refresh timer is due.
    setState(pollState());

    const remaining = Math.max(nextAt - performance.now(), 0);

    tick(remaining, Math.min(remaining / intervalMs, 1));
  };

  /**
   * Stops the loop for good: no more refreshes, and no more clock.
   *
   * The clock has to go too. `drawTick` re-reads `pollState()` every second and
   * pushes it back through `setState`, so a loop that only stopped fetching
   * would keep reporting a verdict it is no longer entitled to.
   */
  const standDown = (): void => {
    showing = false;
    window.clearTimeout(timer);
    window.clearInterval(clockTimer);
  };

  async function refresh(): Promise<void> {
    // One request at a time. A tab returning as its timer fires would otherwise
    // start two, which on a five-second cadence is a doubled poll budget.
    if (inFlight) return;

    // A stood-down loop stays down. `retry` is wired to a button that re-arms
    // itself on a timer, so without this the operator's next tap restarts a loop
    // that deliberately gave up.
    if (!showing) return;

    inFlight = true;

    try {
      const payload = await fetch();

      if (!payload) throw new Error('Snapshot response was unusable');

      landedAt = performance.now();

      render(payload);

      // Lifted in the same frame the numbers land in, rather than left to the
      // next state check.
      setState('live');

      schedule(intervalMs);
    } catch (err) {
      logger.warn('metrics', 'snapshot refresh failed', { err });

      // A challenged edge is the one failure fetching again cannot mend, and
      // dropping the reschedule is the point: the request reaches nothing, and
      // repeating it every five seconds only pushes the device further into
      // whatever the edge is mitigating on. The gate owns the screen from here.
      //
      // `standDown` rather than `band-loop`'s bare `setState('stale'); return;`
      // — this loop's clock would re-derive the state a second later, and its
      // `visibilitychange` handler would reschedule on the next tab switch.
      if (err instanceof ApiError && err.code === 'EDGE_CHALLENGE') {
        setState('stale');
        standDown();

        return;
      }

      // Nothing is said about the panels here. What is on screen is still what
      // the server last said; whether that is old enough to matter is what
      // `pollState` reports, and it is re-read below on the retry cadence.
      setState(pollState());

      schedule(BAND_RETRY_MS);
    } finally {
      inFlight = false;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      window.clearTimeout(timer);

      return;
    }

    if (!showing) return;

    // Report before fetching, not after. On a slow connection the gap between
    // waking and refreshing is exactly when somebody is reading the screen to
    // decide something.
    setState(pollState());

    schedule(0);
  });

  schedule(intervalMs);

  drawTick();

  const clockTimer = window.setInterval(drawTick, 1_000);

  return {
    retry: async () => {
      await refresh();
    },

    suspend: standDown,
  };
};
