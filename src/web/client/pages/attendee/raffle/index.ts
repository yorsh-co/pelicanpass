import { formatNumber, mountReels, rollTo } from './ui/roll.ts';

import api from '../../../core/api/index.ts';
import { createRaffleMessages } from '../../../../../i18n/generated/raffle.messages.ts';
import { readMessages } from '../../../core/i18n.ts';
import { ApiError } from '../../../core/api/api.error.ts';
import layoutDom from '../../../layouts/main/layout-dom.ts';
import { qs } from '../../../layouts/main/dom.ts';
import { setupLogout } from '../../../layouts/main/logout.ts';
import { bootScreen } from '../../../modules/ui/bootScreen.ts';
import { logger } from '../../../modules/log/logger.ts';
import toast from '../../../modules/ui/toast.ts';
import ui from '../../../modules/ui/index.ts';

import type { RaffleView } from '../../../core/api/api.raffle.ts';

/** `[data-raffle="…"]`, resolved with the shared throwing selector. */
const slot = (name: string) => `[data-raffle="${name}"]`;

const dom = Object.freeze({
  number: qs(slot('number')),
  announce: qs(slot('announce')),
  idleHint: qs(slot('copy-idle')),

  drawButton: qs<HTMLButtonElement>(slot('drawButton')),
  repeats: qs<HTMLInputElement>(slot('repeats')),
  hint: qs(slot('hint')),

  counters: qs(slot('counters')),
  drawn: qs(slot('drawn')),
  // Its own copy slot, like `idleHint` above: the element the server fills is
  // the same one whose visibility tracks the list being empty.
  drawnEmpty: qs(slot('copy-drawnEmpty')),
});

/** The page's messages, from the catalog the route inlined. */
const copy = readMessages('raffle', createRaffleMessages);

/**
 * Builds one row of the drawn list.
 *
 * The number, and a control that puts it back. Numbers only, never names: the
 * draw needs no more than a number, and this screen gets pointed at a room.
 *
 * @param draw - The standing draw to render.
 * @param onReset - Called with the draw's ID when its control is used.
 */
const renderRow = (
  draw: { drawId: string; checkinNumber: number },
  onReset: (drawId: string) => void,
): HTMLLIElement => {
  const li = document.createElement('li');
  li.className = 'raffle-drawn-item';

  const value = document.createElement('span');
  value.className = 'raffle-drawn-number';
  value.textContent = formatNumber(draw.checkinNumber);

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'raffle-reset-btn';
  reset.ariaLabel = copy.resetLabel({ checkinNumber: draw.checkinNumber });

  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.ariaHidden = 'true';
  /* copy-ok: icon ligature */
  icon.textContent = 'refresh';

  reset.append(icon);
  reset.addEventListener('click', () => {
    onReset(draw.drawId);
  });

  li.append(value, reset);

  return li;
};

/**
 * Paints the list and the counters from a view.
 *
 * Rebuilt wholesale on every response rather than patched. The list is at most
 * a few hundred rows of two elements, and a surface that reconciled would be a
 * surface that could disagree with the server about what has been called.
 *
 * @param view - The view the server just returned.
 * @param onReset - Handler wired into each row's control.
 */
const render = (view: RaffleView, onReset: (drawId: string) => void): void => {
  // Every render rather than once at startup: the pool grows as people check
  // in, and one crossing from 99 to 100 needs a third reel. Idempotent, so the
  // usual case costs a comparison.
  mountReels(dom.number, String(view.poolMax).length);

  dom.counters.textContent = copy.counters({
    drawn: view.draws.length,
    remaining: view.remaining,
  });

  dom.drawn.replaceChildren(
    ...view.draws.map((draw) => renderRow(draw, onReset)),
  );

  dom.drawnEmpty.hidden = view.draws.length > 0;

  // Nothing left to call, so the control that would call it says so instead of
  // waiting to be tapped and refused. Repeats reopen the pool, which is why
  // this is re-evaluated on every render rather than latched.
  dom.drawButton.disabled = view.remaining === 0 && !dom.repeats.checked;
};

/** Turns a failure into the one line that is true about it. */
const errorCopy = (err: unknown): string => {
  if (!(err instanceof ApiError)) return copy.serverError();

  // Ahead of the switch: an earlier tap still running is a `CONFLICT` too, and
  // the switch reads every `CONFLICT` as an exhausted pool.
  if (
    err.details?.reason === 'requestInProgress' ||
    err.code === 'EDGE_TIMEOUT' ||
    err.code === 'SERVICE_UNAVAILABLE'
  ) {
    return copy.stillWorking();
  }

  switch (err.code) {
    case 'CONFLICT':
      return copy.exhausted();
    case 'NOT_FOUND':
      return copy.resetFailed();
    default:
      return copy.serverError();
  }
};

const init = async (): Promise<void> => {
  document.body.dataset.page = 'raffle';

  /**
   * Puts a number back.
   *
   * Declared before {@link draw} because the rows it builds are wired to it,
   * and both are needed by {@link render}.
   */
  const reset = (drawId: string): void => {
    void (async () => {
      try {
        render(await api.raffle.reset(drawId), reset);
      } catch (err) {
        logger.warn('raffle', 'reset failed', { err });
        void toast.warn(errorCopy(err));

        // Both leave the list on screen out of date: a timed-out reset may have
        // gone through, and `NOT_FOUND` means the number is already back in
        // the pool. Re-read rather than guess.
        if (
          err instanceof ApiError &&
          (err.code === 'EDGE_TIMEOUT' || err.code === 'NOT_FOUND')
        ) {
          try {
            render(await api.raffle.getDraws(), reset);
          } catch (refreshErr) {
            logger.warn('raffle', 'refresh failed', { err: refreshErr });
          }
        }
      }
    })();
  };

  /**
   * The draw's idempotency key, kept across a re-tap after a timeout so the
   * server shows the number it already called instead of calling another.
   * Changing repeats starts a new draw, since it changes which numbers qualify.
   */
  let pendingKey: string | undefined;

  const draw = async (): Promise<void> => {
    // Held for the whole roll, not just the request: the number on screen is
    // still moving after the response lands, and a second draw arriving
    // mid-animation would overwrite the first before anyone had read it.
    dom.drawButton.disabled = true;
    dom.drawButton.classList.add('loading');

    try {
      pendingKey ??= crypto.randomUUID();

      const result = await api.raffle.draw(dom.repeats.checked, pendingKey);

      pendingKey = undefined;

      // Hidden on the first draw and never shown again — the number itself is
      // the instruction from here on.
      dom.idleHint.hidden = true;

      await rollTo(dom.number, result.draw.checkinNumber);

      // After the roll, so it is announced once rather than sixty times a
      // second. The number element itself is aria-hidden for that reason.
      dom.announce.textContent = formatNumber(result.draw.checkinNumber);

      render(result, reset);
    } catch (err) {
      // Kept only when the outcome is unknown or the server never took it;
      // any other answer means this draw is finished.
      const retryable =
        err instanceof ApiError &&
        (err.code === 'EDGE_TIMEOUT' || err.code === 'SERVICE_UNAVAILABLE');

      if (!retryable) pendingKey = undefined;

      logger.warn('raffle', 'draw failed', { err });
      await ui.hint.showError(dom.hint, errorCopy(err));

      // Re-enabled only on this path. The success path leaves the button in
      // whatever state render() decided, which may legitimately be disabled —
      // that was the last number.
      dom.drawButton.disabled = false;
    } finally {
      dom.drawButton.classList.remove('loading');
    }
  };

  dom.drawButton.addEventListener('click', () => {
    void draw();
  });

  // Re-evaluates whether the button should be live: turning repeats on reopens
  // an exhausted pool, and turning it off can close it again.
  dom.repeats.addEventListener('change', () => {
    pendingKey = undefined;

    void (async () => {
      try {
        render(await api.raffle.getDraws(), reset);
      } catch (err) {
        logger.warn('raffle', 'refresh failed', { err });
      }
    })();
  });

  try {
    render(await api.raffle.getDraws(), reset);
  } catch (err) {
    logger.error('raffle', 'initial load failed', { err });
    void toast.warn(copy.serverError());
  }

  bootScreen(layoutDom.bootScreen).hide();
};

// Loaded as a module script, so the document is already parsed.
//
// Logout is wired before init rather than inside it: init awaits the first
// load, and the way out of a surface should not depend on that request having
// come back.
setupLogout();
void init();
