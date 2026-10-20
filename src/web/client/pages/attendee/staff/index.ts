import { STAFF_COPY } from './messages.ts';

import api from '../../../core/api/index.ts';
import { ApiError } from '../../../core/api/api.error.ts';
import layoutDom from '../../../layouts/main/layout-dom.ts';
import { qs, qsOptional } from '../../../layouts/main/dom.ts';
import { setupLogout } from '../../../layouts/main/logout.ts';
import { prefetchScanner, setupQr } from '../../../modules/qr/qr.ts';
import { renderClock, startWallClock } from '../../../modules/ui/clock.ts';
import { renderWindowProgress } from '../../../modules/ui/window-progress.ts';
import {
  setupBandRetry,
  startBandLoop,
} from '../../../modules/ui/band-loop.ts';
import {
  resetSlide,
  setupSlideConfirm,
} from '../../../modules/ui/slide-confirm.ts';
import { MIN_PROCESSING_MS } from '../../../modules/ui/pacing.ts';
import { createRetapMarker } from '../../../modules/ui/retap.ts';
import toast from '../../../modules/ui/toast.ts';
import ui from '../../../modules/ui/index.ts';
import utils from '../../../modules/utils/index.ts';
import { logger } from '../../../modules/log/logger.ts';
import { bootScreen } from '../../../modules/ui/bootScreen.ts';

import {
  formatTicket,
  isValidTicketCode,
} from '../../../../../constants/ticket.ts';

import type {
  RedeemResult,
  ReviewView,
  ServedItem,
} from '../../../core/api/api.staff.ts';
import type { RedemptionItem } from '../../../../../constants/pass.ts';

/**
 * How long the camera is held after a scan before it is released.
 *
 * The trade is speed against a lit camera indicator on someone's own phone: a
 * queue moves faster than this, so consecutive scans are always warm, and a
 * phone put down goes dark within a minute.
 */
const CAMERA_WARM_MS = 60_000;

/** `[data-staff="…"]`, resolved with the shared selectors below. */
const slot = (name: string) => `[data-staff="${name}"]`;

const dom = Object.freeze({
  // The band's four nodes stand or fall together: `PASS_BAND_ENABLED` decides
  // whether the template renders that block at all. The clock is not among
  // them — both branches render one, which is the point of the off state.
  band: qsOptional(slot('band')),
  bandRetry: qsOptional<HTMLButtonElement>(slot('bandRetry')),
  bandBlock: qsOptional(slot('bandBlock')),
  clock: qs(slot('clock')),
  windowBar: qsOptional(slot('windowBar')),

  qrReaderDiv: qs(slot('qr-reader-div')),
  startCameraBtn: qs<HTMLButtonElement>(slot('start-camera-btn')),
  torchBtn: qs<HTMLButtonElement>(slot('qr-torch-btn')),
  switchBtn: qs<HTMLButtonElement>(slot('qr-switch-btn')),
  closeBtn: qs<HTMLButtonElement>(slot('qr-close-btn')),
  hintDiv: qs(slot('qr-hint-div')),

  review: qs(slot('review')),
  reviewBadge: qs(slot('reviewBadge')),
  reviewIdentifier: qs(slot('reviewIdentifier')),
  reviewItems: qs(slot('reviewItems')),
  slideHint: qs(slot('slideHint')),
  reviewOutcome: qs(slot('reviewOutcome')),
  reviewClose: qs<HTMLButtonElement>(slot('reviewClose')),

  lookup: qs<HTMLDetailsElement>(slot('lookup')),
  lookupForm: qs<HTMLFormElement>(slot('lookupForm')),
  lookupInput: qs<HTMLInputElement>(slot('lookupInput')),
  lookupSubmit: qs<HTMLButtonElement>(slot('lookupSubmit')),
});

/* -------------------------------------------------------------------------- */
/* the band                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Keeps the volunteer's own band block current — the word, the clock and the
 * window bar, which together are what the attendee's pass is compared against.
 *
 * The loop is `startBandLoop`, the same one the attendee's pass runs. That is
 * the point: the two screens agree because neither was told what the other
 * shows, and a second copy of the timing would be a second chance to disagree.
 * What is left here is where this screen paints.
 *
 * A stale band matters more here than on the pass. An attendee showing a frozen
 * band is refused and reloads; a *volunteer* comparing against a frozen band
 * refuses everyone. So the block is covered rather than greyed — a greyed word
 * is still a legible word.
 *
 * @param nodes - The band block's own elements, narrowed once by the caller so
 *   the paint callbacks below need no guard of their own.
 */
const startBand = (nodes: {
  band: HTMLElement;
  bandBlock: HTMLElement;
  bandRetry: HTMLButtonElement;
  windowBar: HTMLElement;
}): void => {
  const loop = startBandLoop({
    fetch: api.staff.getBand,

    render: (current) => {
      nodes.band.textContent = current.band.word;

      // The colour is decoration and the word is the identity, so the hue rides
      // on a data attribute the stylesheet reads rather than on an inline style.
      nodes.band.dataset.colour = current.band.colour.toLowerCase();

      // Refilled here rather than left to the next tick: this is the window
      // boundary, which is the moment the bar is most likely to be looked at.
      renderWindowProgress(nodes.windowBar, current.expiresInMs);
    },

    // `pending` covers the gap at the end of every window, in which the band
    // has expired and its replacement is already in flight. It hides the word
    // rather than greying it: this screen and the attendee's refresh
    // independently, so a readable word during the gap can be the one *before*
    // the pass is showing.
    setState: (state) => {
      nodes.bandBlock.classList.toggle('is-stale', state === 'stale');
      nodes.bandBlock.classList.toggle('is-pending', state === 'pending');
    },

    tick: (remainingMs) => {
      renderClock(dom.clock);
      renderWindowProgress(nodes.windowBar, remainingMs);
    },

    // A literal because this route has no other: `/staff` renders with
    // `audience: … ?? 'volunteer'`.
    unauthorizedHref: () => '/checkin?error=UNAUTHORIZED&audience=volunteer',
  });

  setupBandRetry(nodes.bandRetry, loop);

  // No seed and never suspended: the server renders no band into this page, and
  // the screen has no second face to turn to.
  loop.resume();
};

/**
 * Starts whichever sign of life this deployment renders.
 *
 * With `PASS_BAND_ENABLED` off there is no band block and no endpoint behind
 * it, so the screen keeps a bare clock and polls nothing. The four nodes are
 * checked together because the template renders them together; a missing one
 * on the enabled path is a broken template, and a clock is the safer thing to
 * fall back to than a loop painting into nowhere.
 */
const startBandBlock = (): void => {
  const { band, bandBlock, bandRetry, windowBar } = dom;

  if (band && bandBlock && bandRetry && windowBar) {
    startBand({ band, bandBlock, bandRetry, windowBar });

    return;
  }

  startWallClock(dom.clock);
};

/* -------------------------------------------------------------------------- */
/* the review                                                                  */
/* -------------------------------------------------------------------------- */

let handle: string | null = null;

/**
 * Who the open card is for, as the card names them. Stable across scans, unlike
 * the handle, which a re-scan replaces.
 */
let cardIdentifier = '';

/**
 * A handover whose answer never arrived. Its re-slide is answered `duplicate`
 * when the first went through, which this turns back into the redemption it
 * was. Keyed on the attendee and the item, so a re-scan in between still
 * matches.
 */
const handoverRetap = createRetapMarker();

const closeReview = (): void => {
  handle = null;
  dom.review.hidden = true;
  dom.reviewOutcome.hidden = true;
};

const showOutcome = (text: string, kind: string): void => {
  dom.reviewOutcome.textContent = text;
  dom.reviewOutcome.dataset.kind = kind;
  dom.reviewOutcome.hidden = false;
};

/**
 * Builds one item row.
 *
 * An already-collected item and one they were never entitled to are both
 * untappable, but they are not the same thing and do not read the same — the
 * volunteer has a different sentence to say in each case.
 */
const renderItem = (entry: ServedItem): HTMLLIElement => {
  const li = document.createElement('li');
  li.className = 'staff-item';

  const entitled = entry.value !== null;
  const done = Boolean(entry.redeemedAt);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'staff-item-btn';
  button.disabled = !entitled || done || !entry.inScope;
  button.dataset.item = entry.item;

  const name = document.createElement('span');
  name.className = 'staff-item-name';
  name.textContent = entry.value
    ? STAFF_COPY.itemValue(entry.item, entry.value)
    : STAFF_COPY.itemLabel(entry.item);

  // Absolutely positioned by the stylesheet, so it joins neither the flex row
  // nor the tab order — the thumb is where the finger goes, not a second
  // control. Only actionable rows get one.
  if (!button.disabled) {
    const thumb = document.createElement('span');
    thumb.className = 'staff-item-thumb';
    thumb.ariaHidden = 'true';

    // Two glyphs, swapped by the stylesheet at the threshold: a direction to
    // travel in at rest, and a confirmation once letting go would commit. The
    // swap is what makes the armed point legible to someone who does not
    // separate the two fill colours.
    const go = document.createElement('span');
    go.className = 'material-symbols-outlined staff-item-thumb-go';
    /* copy-ok: icon ligature */
    go.textContent = 'keyboard_double_arrow_right';

    const okay = document.createElement('span');
    okay.className = 'material-symbols-outlined staff-item-thumb-ok';
    /* copy-ok: icon ligature */
    okay.textContent = 'check';

    thumb.append(go, okay);
    button.append(thumb);

    // Armed in the same breath as the thumb it measures.
    setupSlideConfirm(button, thumb, () => {
      void handOver(entry.item, button);
    });
  }

  // Most informative first. "Never had one" leaves nowhere to send them, so it
  // outranks the station; a collected item answers the question even from the
  // wrong table, so it outranks it too.
  const state = document.createElement('span');
  state.className = 'staff-item-state';
  state.textContent = !entitled
    ? STAFF_COPY.notEntitled
    : done
      ? STAFF_COPY.redeemed
      : !entry.inScope
        ? STAFF_COPY.otherStation
        : STAFF_COPY.pending;

  button.append(name, state);

  li.append(button);

  return li;
};

const renderReview = (review: ReviewView): void => {
  handle = review.handle;

  const isVolunteer = review.attendeeRole === 'volunteer';
  dom.reviewBadge.textContent = isVolunteer ? STAFF_COPY.volunteerBadge : '';
  dom.reviewBadge.hidden = !isVolunteer;

  cardIdentifier =
    review.identifier.kind === 'checkinNumber'
      ? `#${String(review.identifier.value)}`
      : review.identifier.value;

  dom.reviewIdentifier.textContent = cardIdentifier;

  dom.reviewItems.replaceChildren(...review.items.map(renderItem));

  // Only worth saying when there is something to slide. A card of collected and
  // out-of-station items has no gesture to explain.
  dom.slideHint.hidden = !review.items.some(
    (entry) => entry.inScope && entry.value !== null && !entry.redeemedAt,
  );

  dom.reviewOutcome.hidden = true;
  dom.review.hidden = false;
  dom.lookup.open = false;

  // `nearest` so an already-visible card does not jump. This matters most for
  // the typed fallback: the volunteer is at the bottom of the page with the
  // lookup form open, and the review renders above them — without this, a
  // successful search looks like nothing happened.
  dom.review.scrollIntoView({ block: 'nearest' });
};

/**
 * Records a handover and reports what the server made of it.
 *
 * `duplicate` and `not_entitled` arrive as successes and are shown as answers.
 * Only a transport failure is an error — the distinction matters at a counter,
 * where "already collected" is information and "try again" is not.
 */
const handOver = async (
  item: RedemptionItem,
  button: HTMLButtonElement,
): Promise<void> => {
  if (!handle) return;

  button.disabled = true;
  ui.element.setProcessing(dom.review, true);

  const retapKey = `${cardIdentifier}:${item}`;

  try {
    const result: RedeemResult = await api.staff.redeem(handle, item);

    // Read first and unconditionally, so any answer clears the mark.
    const retapped = handoverRetap.take(retapKey);
    const outcome =
      retapped && result.outcome === 'duplicate' ? 'redeemed' : result.outcome;

    showOutcome(STAFF_COPY.outcome(result.item, outcome), outcome);

    const state = button.querySelector('.staff-item-state');

    if (state) {
      state.textContent =
        outcome === 'not_entitled'
          ? STAFF_COPY.notEntitled
          : STAFF_COPY.redeemed;
    }

    // The row is spent either way — it stays disabled from here — so it loses
    // the thumb and reads exactly like one that was already collected when the
    // card opened.
    button.querySelector('.staff-item-thumb')?.remove();
  } catch (err) {
    logger.warn('staff', 'redeem failed', { err });

    if (err instanceof ApiError && err.code === 'EDGE_TIMEOUT') {
      handoverRetap.mark(retapKey);
    } else {
      handoverRetap.take(retapKey);
    }

    // A 403 here is not a fault: this volunteer's stations changed while the
    // card was open, which is what the per-request scope read is for. The
    // button stays disabled, because tapping it again cannot help.
    const forbidden = err instanceof ApiError && err.code === 'FORBIDDEN';

    if (!forbidden) button.disabled = false;

    // A shed or a timeout is worth a moment's wait, not "something went wrong".
    // After a timeout the item may already be recorded, and a second tap then
    // answers `duplicate` rather than handing anything out twice.
    const slow =
      err instanceof ApiError &&
      (err.code === 'EDGE_TIMEOUT' || err.code === 'SERVICE_UNAVAILABLE');

    void toast.error(
      forbidden
        ? STAFF_COPY.redeemForbidden
        : slow
          ? STAFF_COPY.slowResponse
          : STAFF_COPY.redeemFailed,
    );
  } finally {
    ui.element.setProcessing(dom.review, false);

    // Held at full while the request was in flight, as proof the gesture took.
    // Cleared once there is an answer, whichever it was.
    resetSlide(button);
  }
};

/* -------------------------------------------------------------------------- */
/* wiring                                                                      */
/* -------------------------------------------------------------------------- */

const setupLookup = (): void => {
  // Normalised on every keystroke, the same way the check-in ticket field is:
  // lowercased, stripped to the characters a code can hold, and capped at six.
  // A check-in number therefore cannot be typed in here in the first place.
  dom.lookupInput.addEventListener('input', () => {
    dom.lookupInput.value = formatTicket(dom.lookupInput.value);
  });

  dom.lookupForm.addEventListener('submit', (event) => {
    event.preventDefault();

    void (async () => {
      const query = dom.lookupInput.value.trim();

      // The button's own `disabled` doubles as the re-entry guard. It has to,
      // because a disabled submit button does not stop Enter in the field from
      // submitting the form — and the input asks for Enter by carrying
      // `enterkeyhint="search"`.
      if (!query || dom.lookupSubmit.disabled) return;

      // The same rule the server applies, applied before the round trip. A
      // partial code is the ordinary case here — the field submits on Enter,
      // and the volunteer may not have finished typing.
      if (!isValidTicketCode(query)) {
        void toast.warn(STAFF_COPY.lookupFailed);
        return;
      }

      const startTime = Date.now();

      dom.lookupSubmit.classList.add('loading');
      dom.lookupSubmit.disabled = true;

      try {
        const review = await api.staff.lookup(query);

        // Held to the same floor the scanner holds its own "Conferindo…" to,
        // so the two ways into a review take the same beat. Measured from the
        // request, so a slow network pays nothing on top.
        await utils.timing.ensureMinimum(startTime, MIN_PROCESSING_MS);

        renderReview(review);
        dom.lookupInput.value = '';
      } catch (err) {
        logger.warn('staff', 'lookup failed', { err });

        await utils.timing.ensureMinimum(startTime, MIN_PROCESSING_MS);

        // Three problems with three answers: check the number, wait a few
        // minutes, or fetch someone. A spent miss budget used to fall through to
        // the last of those, which sends a volunteer off their counter looking
        // for help with something that clears itself.
        const code = err instanceof ApiError ? err.code : undefined;

        const message =
          code === 'NOT_FOUND' || code === 'VALIDATION_ERROR'
            ? STAFF_COPY.lookupFailed
            : code === 'RATE_LIMITED'
              ? STAFF_COPY.lookupRateLimited
              : STAFF_COPY.serverError;

        void toast.warn(message);
      } finally {
        dom.lookupSubmit.classList.remove('loading');
        dom.lookupSubmit.disabled = false;
      }
    })();
  });
};

const init = (): void => {
  document.body.dataset.page = 'staff';

  dom.reviewClose.addEventListener('click', closeReview);

  setupQr({
    qrReaderDiv: dom.qrReaderDiv,
    startCameraBtn: dom.startCameraBtn,
    hintDiv: dom.hintDiv,
    torchBtn: dom.torchBtn,
    switchBtn: dom.switchBtn,
    closeBtn: dom.closeBtn,
    copy: STAFF_COPY.qr,

    // Held between scans, so a queue does not pay `getUserMedia` per attendee.
    // A minute is long enough that consecutive scans are always warm and short
    // enough that a phone set down goes dark — which matters, because holding
    // the track keeps the camera indicator lit on a volunteer's own device.
    keepWarmMs: CAMERA_WARM_MS,

    // These three are optional on `setupQr` and doing without them is why a
    // refused scan used to fail silently: the module reports every scan failure
    // through `onError` and nowhere else, so with no callback the camera simply
    // paused and resumed with nothing on screen.
    onProcessingStart: (msg) => ui.hint.showHint(dom.hintDiv, msg),
    onProcessingEnd: (msg) =>
      msg === null ? Promise.resolve() : ui.hint.showHint(dom.hintDiv, msg),
    onError: (msg) => ui.hint.showError(dom.hintDiv, msg),

    // The `ApiError` is deliberately not caught here. `setupQr` maps
    // `err.code` through `copy.error` itself, and wrapping it in a plain
    // `Error` first threw that code away — every failure, including a 500,
    // came back as the generic message with the specific one unreachable.
    //
    // Throwing resumes the scanner, which is what a refused pass wants: the
    // volunteer reads why and the camera keeps running.
    onScan: async (token) => {
      renderReview(await api.staff.verify(token));

      // `setupQr` calls `onProcessingEnd` only when a scan fails — a successful
      // one closes the viewfinder without one. So the "Conferindo…" that
      // `onProcessingStart` put up is ours to take down, or it sits under a
      // closed camera reading like a hang.
      //
      // Restored to the idle hint rather than cleared: the camera has just
      // closed and the next thing this volunteer does is scan someone else.
      await ui.hint.showHint(dom.hintDiv, STAFF_COPY.qr.defaultHint);
    },
  });

  setupLookup();
  setupLogout();
  startBandBlock();

  bootScreen(layoutDom.bootScreen).hide();

  // After the boot screen, so it competes with nothing the volunteer is waiting
  // on. By their first scan the chunk is already in the module cache.
  prefetchScanner();
};

// Loaded as a module script, so the document is already parsed.
init();
