import { ApiError } from '../../core/api/api.error.ts';
import { logger } from '../log/logger.ts';

import {
  BAND_CLOCK_MS,
  BAND_GRACE_MS,
  BAND_LAG_MS,
  BAND_RETRY_MS,
  retryDelay,
} from './pacing.ts';

/**
 * The minimum a response must carry for the loop to schedule from it.
 *
 * Both endpoints return a superset: the pass adds a QR and the redemption
 * chips, the volunteer's band adds nothing. Typing the loop against the
 * intersection is what lets one implementation serve both without either
 * caller casting.
 */
export interface BandPayload {
  /**
   * The window's band, absent where `PASS_BAND_ENABLED` is off.
   *
   * The loop never reads it — it schedules on `expiresInMs` alone, which the
   * pass still needs with the band off because that window is also the token's.
   * Only the `render` callbacks look, and each guards for itself.
   */
  band?: { colour: string; word: string };
  expiresInMs: number;
}

/**
 * What the band slot is showing.
 *
 * Three states rather than two, because "expired for 300 ms while its
 * replacement is in flight" and "this screen stopped refreshing" are not the
 * same thing and only one of them is worth a button.
 */
export type BandState = 'live' | 'pending' | 'stale';

/** Everything the loop needs to poll a window and report on it. */
export interface BandLoopParams<T extends BandPayload> {
  /**
   * Fetches the next window. A `null` is a malformed payload rather than a
   * transport failure — both API clients answer that way — and is treated as a
   * failed refresh.
   */
  fetch: () => Promise<T | null>;

  /** Paints whatever the response carries. */
  render: (payload: T) => void;

  /** Paints the live/pending/stale cover on the band block. */
  setState: (state: BandState) => void;

  /** Redraws the clock and the window bar, once a second. */
  tick: (remainingMs: number) => void;

  /** Where a *manual* retry sends a session that has died. */
  unauthorizedHref: () => string;

  /**
   * The window the server already rendered into the page.
   *
   * Omitted by a screen the server seeds nothing into, which then opens on the
   * shimmer of a request already in flight rather than on a refresh button.
   */
  seedExpiresInMs?: number;

  /** Starts suspended, for a surface that is not on screen yet. */
  startSuspended?: boolean;
}

/** The handle a page drives the loop with. */
export interface BandLoop {
  /** The surface is up: refresh if the window has lapsed, then keep it. */
  resume: () => void;

  /** The surface is down: stop scheduling. */
  suspend: () => void;

  /** Fetch now without rescheduling, for a last read on the way down. */
  refresh: () => Promise<void>;

  /**
   * Fetch now at the user's request.
   *
   * Resolves once the attempt has settled, whether it landed or not, so the
   * caller can re-arm its button. A dead session redirects rather than backing
   * off — see the `catch` below for why only a manual attempt may do that.
   */
  retry: () => Promise<void>;
}

/**
 * Polls a rotating window and keeps a band block current.
 *
 * Two timers, deliberately separate. The clock ticks every second and touches
 * nothing but the DOM. The refresh is a *chained* timeout rather than an
 * interval: it is scheduled from the server's own `expiresInMs`, so it tracks
 * the rotation window instead of drifting against it, and a chain cannot stack
 * up behind a slow request the way a fixed interval can.
 *
 * Both screens that use this care about their own lifecycle. A backgrounded tab
 * has its timers throttled to roughly once a minute, and iOS suspends them
 * outright when the screen locks — which is exactly what an attendee does
 * between opening their pass and reaching the counter. Coming back to a band
 * that stopped rotating four minutes ago is worse than coming back to no band
 * at all: it is wrong, and it looks right.
 *
 * The loop touches no DOM and knows neither screen. It is handed a fetch and
 * three paint callbacks, which is what lets the attendee's pass and the
 * volunteer's band block run the same code over different markup — and they
 * must agree, because comparing one against the other is the entire mechanism.
 *
 * @param params - The fetch, the paint callbacks, and where a dead session goes.
 * @returns The handle the page turns the polling on and off with.
 */
export const startBandLoop = <T extends BandPayload>({
  fetch,
  render,
  setState,
  tick,
  unauthorizedHref,
  seedExpiresInMs,
  startSuspended = false,
}: BandLoopParams<T>): BandLoop => {
  // With no seed this lands on `performance.now()`, which reads as expired
  // immediately — the screen opens on the shimmer of the first request rather
  // than on a refresh button. Zero would read as expired since the epoch.
  let expiresAt = performance.now() + (seedExpiresInMs ?? 0);

  let refreshTimer: number | undefined;
  let clockTimer: number | undefined;
  let inFlight = false;

  /** Whether the surface is on screen. Nothing is scheduled while it is not. */
  let showing = !startSuspended;

  /** Whether the displayed band has outlived the window it was minted for. */
  const isExpired = (): boolean => performance.now() > expiresAt;

  /**
   * What the band slot should be showing, from one number: how long the
   * displayed band has been expired.
   *
   * Every window ends with a gap — the next band is asked for `BAND_LAG_MS`
   * past the boundary and then has a round trip to make — so a bare
   * `isExpired()` put a refresh button on screen twice a minute for a band that
   * was already on its way. The grace covers that gap and nothing longer.
   */
  const bandState = (): BandState => {
    const age = performance.now() - expiresAt;

    if (age <= 0) return 'live';

    return age > BAND_GRACE_MS ? 'stale' : 'pending';
  };

  const refresh = async ({ manual = false } = {}): Promise<void> => {
    // One request at a time. Returning to a tab whose timer fires as the
    // visibility handler runs would otherwise start two.
    if (inFlight) return;

    inFlight = true;

    try {
      const payload = await fetch();

      if (!payload) throw new Error('Band response was unusable');

      expiresAt = performance.now() + payload.expiresInMs;

      render(payload);

      // Owned here rather than left to the next tick, so the cover lifts in the
      // same frame the band lands in.
      setState('live');

      schedule(payload.expiresInMs + BAND_LAG_MS);
    } catch (err) {
      // A network failure rejects as a bare TypeError rather than an ApiError,
      // so this catches both by not testing for either.
      logger.warn('band', 'band refresh failed', { err });

      // A dead session is the one failure fetching again cannot mend — the loop
      // would spin on it until someone gave up.
      if (err instanceof ApiError && err.status === 401) {
        // On a tap, send them where the server would have sent them anyway,
        // but carrying the reason: an unexplained bounce to check-in reads as
        // the screen losing sessions rather than as the session already being
        // gone.
        if (manual) {
          window.location.href = unauthorizedHref();

          return;
        }

        // Automatically, stop instead: a redirect would take an attendee off
        // their pass with the phone in their pocket. Stopping matters beyond
        // this phone. These requests are anonymous, so each one is charged to
        // the per-IP limit the whole venue shares, and a few pockets polling
        // every five seconds would spend it for everyone behind the same
        // address. The stale cover's retry button turns the next attempt into
        // the tap above.
        setState('stale');

        return;
      }

      // A challenged edge is the other failure fetching again cannot mend, and
      // like the 401 above it stops automatic refreshes: the gate is a prompt
      // rather than a redirect, so it cannot take an attendee off their pass
      // with the phone in their pocket. Dropping the reschedule is the point —
      // the request reaches nothing, and repeating it every five seconds only
      // pushes the device further into whatever the edge is mitigating on. The
      // gate owns the screen from here.
      if (err instanceof ApiError && err.code === 'EDGE_CHALLENGE') {
        setState('stale');

        return;
      }

      // Nothing is said about the band here. A failure inside a live window
      // leaves a band that is still valid, and one at a boundary is covered by
      // the grace; the tick reports whichever of those it turns out to be.
      schedule(
        retryDelay(
          err instanceof ApiError ? err.details?.retryAfterSeconds : undefined,
        ),
      );
    } finally {
      inFlight = false;
    }
  };

  /**
   * Queues the next refresh, unless the surface has gone back down.
   *
   * The one guard that makes the whole thing suspendable: it catches the
   * success path, the `BAND_RETRY_MS` backoff and the initial schedule alike,
   * so a fetch in flight when the surface is hidden cannot start a new chain
   * behind it.
   */
  function schedule(delay: number): void {
    window.clearTimeout(refreshTimer);

    if (!showing) return;

    refreshTimer = window.setTimeout(() => void refresh(), delay);
  }

  const drawTick = (): void => {
    tick(expiresAt - performance.now());

    // The clock is the cheapest place to notice that the refresh never landed —
    // a throttled tab wakes here before its refresh timer is due.
    setState(bandState());
  };

  const stop = (): void => {
    window.clearTimeout(refreshTimer);
    window.clearInterval(clockTimer);
  };

  const start = (): void => {
    stop();

    drawTick();
    clockTimer = window.setInterval(drawTick, BAND_CLOCK_MS);

    // Anything already past its window is refreshed now rather than waited out.
    // A window with time left on it is not: the band is still correct, and
    // spending a request to hear that costs a round trip on every app switch.
    schedule(isExpired() ? 0 : expiresAt - performance.now() + BAND_LAG_MS);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // A tab returning to a surface that is down has nothing to catch up on.
      if (!showing) return;

      // Report the band before the request, not after it. On a slow connection
      // the gap between waking and refreshing is exactly when someone is
      // holding the phone out to be checked.
      setState(bandState());

      start();

      return;
    }

    stop();
  });

  // No teardown beyond that: the listener lives as long as the page, and the
  // page is one document per pass.
  return {
    resume: () => {
      showing = true;

      // Same ordering as the wake above, for the same reason: the gap between
      // the surface coming up and the band landing is exactly when it is being
      // held out.
      setState(bandState());

      start();
    },

    suspend: () => {
      showing = false;
      stop();
    },

    refresh: () => refresh(),

    retry: () => refresh({ manual: true }),
  };
};

/**
 * Wires the button that replaces a stalled band.
 *
 * Narrowed to `retry` rather than taking a whole {@link BandLoop}: the pass
 * hands over its own controller, which exposes only what `ui/face.ts` may
 * drive, and this button needs no more than the one method.
 *
 * @param button - The `.band-retry` button on this screen.
 * @param loop - Anything that can retry, absent when the render seeded nothing
 *   to refresh — with nothing to put back in place, a page reload is the honest
 *   action.
 */
export const setupBandRetry = (
  button: HTMLButtonElement,
  loop?: Pick<BandLoop, 'retry'>,
): void => {
  button.onclick = () => {
    if (!loop) {
      window.location.reload();

      return;
    }

    void (async () => {
      button.disabled = true;

      await loop.retry();

      // Re-armed on the loop's own backoff. While an attempt is in flight, or
      // one is about to fire by itself, a second tap has nothing to offer — and
      // these endpoints share a 30-point bucket with the page itself, so mashing
      // it could rate-limit someone out of their own pass.
      window.setTimeout(() => {
        button.disabled = false;
      }, BAND_RETRY_MS);
    })();
  };
};
