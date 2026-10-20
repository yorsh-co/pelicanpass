import api from '../../../../core/api/index.ts';
import { ApiError } from '../../../../core/api/api.error.ts';
import { logger } from '../../../../modules/log/logger.ts';
import { FRONT_POLL_MS } from '../../../../modules/ui/pacing.ts';
import { renderAccess, renderItems, renderWelcome } from './pass.ts';
import { renderSurveyState } from './survey.ts';

/** Turns the front's status poll on and off with its face. */
export interface FrontPoll {
  /** The front is up: poll again a full interval from now. */
  resume: () => void;

  /** The back is up: stop, and leave the polling to `ui/live.ts`. */
  suspend: () => void;
}

/**
 * Keeps the front of the pass current: the chips, including a collected one
 * whose hour is up, the survey card, which an administrator can open at any
 * moment, and the welcome line, which switches at the scheduled times.
 *
 * A separate, lighter request than the back's, at the same thirty seconds. The
 * back's poll carries a QR and a fresh token, which is what the front was
 * deliberately spared; this one carries a few hundred bytes.
 *
 * Paused while the tab is hidden, like the band loop, and caught up on return
 * if an interval has passed. A dead session or an edge challenge stops it
 * without redirecting: nothing here is worth taking an attendee off their pass
 * with the phone in their pocket, and the next reload or turn of the pass will
 * say what is wrong.
 *
 * @returns The controller `ui/face.ts` drives. Starts running, as the pass
 *   opens on its front and the render has just seeded both chips and card.
 */
export const startFrontPoll = (): FrontPoll => {
  let timer: number | undefined;
  let showing = true;
  let stopped = false;
  let lastAt = performance.now();

  const schedule = (delay: number): void => {
    window.clearTimeout(timer);

    if (!showing || stopped || document.visibilityState !== 'visible') return;

    timer = window.setTimeout(() => void poll(), delay);
  };

  const poll = async (): Promise<void> => {
    lastAt = performance.now();

    try {
      const status = await api.attendee.getPassStatus();

      if (!status) throw new Error('Status response was unusable');

      // The face may have turned while the request was out; the back owns the
      // chips from then on.
      if (!showing) return;

      renderItems(status.items);
      renderWelcome(status.welcome, status.welcomeText);
      renderAccess(status.accessTier);
      renderSurveyState(status.survey);
    } catch (err) {
      logger.warn('pass', 'front status poll failed', { err });

      if (
        err instanceof ApiError &&
        (err.status === 401 || err.code === 'EDGE_CHALLENGE')
      ) {
        stopped = true;

        return;
      }
    }

    schedule(FRONT_POLL_MS);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      window.clearTimeout(timer);

      return;
    }

    schedule(Math.max(0, lastAt + FRONT_POLL_MS - performance.now()));
  });

  schedule(FRONT_POLL_MS);

  return {
    resume: () => {
      showing = true;
      lastAt = performance.now();
      schedule(FRONT_POLL_MS);
    },

    suspend: () => {
      showing = false;
      window.clearTimeout(timer);
    },
  };
};
