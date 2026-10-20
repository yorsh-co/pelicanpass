/**
 * The wall clock, in one format.
 *
 * Two screens draw it — the attendee's pass and the volunteer's band block —
 * and they are read side by side across a counter. A drift in options between
 * two copies of this, one 24-hour and one 12-hour, would break the comparison
 * the clocks exist for.
 *
 * Built once at module scope: it is called twice a second across those two
 * screens, and constructing the formatter is the expensive half of the work.
 * The page's `lang` is fixed for its lifetime, so reading it once is enough.
 */
const format = new Intl.DateTimeFormat(document.documentElement.lang, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Writes the device's current time into an element.
 *
 * @param el - Element to write into.
 */
export const renderClock = (el: Element): void => {
  el.textContent = format.format(new Date());
};

/** How often a free-running clock redraws. The same second every tick keeps. */
const CLOCK_MS = 1_000;

/**
 * Keeps a clock element ticking for the life of the page.
 *
 * For the surfaces that have no polling loop to hang a tick on: the front of
 * the pass, which never refreshes, and the volunteer's screen with the band
 * turned off, which has nothing left to poll for. Where a loop already runs,
 * its own `tick` calls {@link renderClock} instead — a second timer beside it
 * would only be a second chance to disagree.
 *
 * Redraws on every wake as well as on the interval. A backgrounded tab has its
 * timers throttled to about once a minute and iOS suspends them outright at
 * screen lock, so a phone taken out of a pocket resumes holding whatever time
 * it was locked at. Waiting for the first interval to correct it shows a stale
 * clock during the seconds it is being held out and then jumps it a minute,
 * which reads worse than frozen.
 *
 * No teardown: the listener lives as long as the page, and these are both one
 * document per screen.
 *
 * @param el - Element to write the time into.
 */
export const startWallClock = (el: Element): void => {
  let timer: number | undefined;

  const tick = (): void => {
    renderClock(el);
  };

  /** Idempotent: a duplicate wake cannot leave two intervals running. */
  const start = (): void => {
    window.clearInterval(timer);

    tick();
    timer = window.setInterval(tick, CLOCK_MS);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      start();

      return;
    }

    window.clearInterval(timer);
  });

  start();
};
