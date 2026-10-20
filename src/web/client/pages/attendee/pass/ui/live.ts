import api from '../../../../core/api/index.ts';
import { startBandLoop } from '../../../../modules/ui/band-loop.ts';
import store from '../state/store.ts';
import { renderClock, renderLive, renderWindow, setBandState } from './pass.ts';
import { renderSurveyState } from './survey.ts';

import type { BandLoop } from '../../../../modules/ui/band-loop.ts';
import type { AttendeePass } from '../../../../core/api/api.attendee.ts';

/** Turns the polling on and off with the face it belongs to. */
export interface LiveController {
  /** The back is up: refresh now, then keep the window. */
  resume: () => void;

  /** The front is up: fetch once more, then stop. */
  suspend: () => void;

  /**
   * Fetch now rather than waiting out the backoff, at the attendee's request.
   *
   * Resolves once the attempt has settled, whether it landed or not, so the
   * caller can re-arm its button.
   */
  retry: () => Promise<void>;
}

/**
 * Where a dead session is sent from the pass.
 *
 * The pass page renders with no `audience`, so the profile is the only thing
 * here that knows which voice check-in should answer in.
 */
export const unauthorizedHref = (): string => {
  const role = store.getState().profile?.attendeeRole;

  return role
    ? `/checkin?error=UNAUTHORIZED&audience=${encodeURIComponent(role)}`
    : '/checkin?error=UNAUTHORIZED';
};

/**
 * Keeps the live half of the pass live.
 *
 * The loop itself is {@link startBandLoop}, shared with the volunteer's band
 * block — the two screens must show the same word for the comparison at the
 * counter to mean anything, and they do that by running the same code. What is
 * left here is the pass's own half: where its band is painted, where a dead
 * session goes, and the last fetch on the way down.
 *
 * Nothing here polls until the pass is turned over. Each response carries a
 * rendered QR and costs an indexed read, and the code is on the back — spending
 * that on a face nobody is looking at buys nothing. The front keeps its chips
 * and the survey card current through `ui/front-poll.ts` instead.
 *
 * @param seed - The pass the server rendered into the page.
 * @returns The controller `ui/face.ts` drives.
 */
export const startLive = (seed: AttendeePass): LiveController => {
  const loop: BandLoop = startBandLoop({
    fetch: api.attendee.getPass,

    // The questionnaire's state rides the same payload, so the card follows
    // the window while the back is up; `ui/front-poll.ts` covers the front.
    render: (pass) => {
      renderLive(pass);
      renderSurveyState(pass.survey);
    },
    setState: setBandState,
    tick: (remainingMs) => {
      renderClock();
      renderWindow(remainingMs);
    },
    unauthorizedHref,

    // The seed is what the page was rendered with, so it is already correct for
    // this window; the loop only has to keep it that way.
    seedExpiresInMs: seed.expiresInMs,

    // The pass opens on its front. Polling starts when it is turned over.
    startSuspended: true,
  });

  return {
    resume: loop.resume,

    retry: loop.retry,

    suspend: () => {
      loop.suspend();

      // One last fetch, so a redemption recorded while the attendee was at the
      // counter reaches the chips they are turning back to. Scheduling is
      // already closed by `suspend`, so this cannot restart the chain.
      void loop.refresh();
    },
  };
};
