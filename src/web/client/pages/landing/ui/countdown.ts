import { splitCountdown } from '../../../../../constants/countdown.ts';
import { createLandingMessages } from '../../../../../i18n/generated/landing.messages.ts';
import { readMessages } from '../../../core/i18n.ts';
import { mountDigit, setDigit } from './digit-reel.ts';

import type { CountdownParts } from '../../../../../constants/countdown.ts';
import type { DigitReel } from './digit-reel.ts';

const copy = readMessages('landing', createLandingMessages);

/** How often the countdown redraws. */
const TICK_MS = 1_000;

/** Below this, the tiles collapse to the seconds alone. */
const FINAL_MINUTE_MS = 60_000;

/** Set on the container while the last minute runs; the stylesheet does the rest. */
const FINAL_MINUTE_CLASS = 'is-final-minute';

/** The three units drawn as tiles, in the order they appear. */
const UNITS = ['hours', 'minutes', 'seconds'] as const;

type Unit = (typeof UNITS)[number];

/** Options {@link startCountdown} is driven by. */
export interface CountdownOptions {
  /** The countdown container, holding the day pill and the three tiles. */
  root: HTMLElement;

  /** Epoch milliseconds, on the server's clock, that the window opens at. */
  opensAt: number;

  /**
   * Difference between the server's clock and this device's, captured once at
   * boot. Added to every `Date.now()` below.
   */
  offsetMs: number;

  /** Called once, when the window opens. */
  onOpen: () => void;
}

/**
 * Counts down to the moment check-in opens.
 *
 * Every tick recomputes the remainder from an absolute instant rather than
 * decrementing a running total. That is what makes the clock survive the two
 * things that happen to it on a phone: a backgrounded tab has its timers
 * throttled to roughly once a minute, and iOS suspends them outright at screen
 * lock. A decrementing counter comes back from either one wrong by however long
 * it was away; this one comes back right.
 *
 * The `offsetMs` correction is the other half of the same idea. The countdown
 * has to end when the *server* opens the window, not when this handset thinks
 * it should — a phone whose clock is ten minutes fast would otherwise send its
 * owner to a page that is still a curtain.
 *
 * Only digits that actually changed are rolled. That is what produces the
 * cascade — one digit most seconds, two every tenth, four as a minute turns —
 * without any stagger machinery: it falls out of comparing this reading against
 * the last.
 *
 * @param options - Container, target, clock correction and the open callback.
 */
export const startCountdown = ({
  root,
  opensAt,
  offsetMs,
  onOpen,
}: CountdownOptions): void => {
  const remainingNow = (): number => opensAt - (Date.now() + offsetMs);

  let parts = splitCountdown(remainingNow());

  const reels = mountReels(root, parts);
  const daysEl = root.querySelector<HTMLElement>('[data-landing="days"]');
  const daysValueEl = root.querySelector('[data-landing="days-value"]');
  const daysLabelEl = root.querySelector('[data-landing="days-label"]');

  let timer: number | undefined;
  let opened = false;

  const renderDays = (next: CountdownParts): void => {
    if (!daysEl) return;

    // Hidden rather than shown as `0 dias`: inside the last day the pill has
    // nothing left to say, and dropping it is what tightens the display as the
    // event gets close.
    daysEl.hidden = next.days === 0;

    if (daysValueEl) daysValueEl.textContent = String(next.days);

    // Re-rendered with the number: the page opens with one day count and can
    // cross into another while it stays open.
    if (daysLabelEl) daysLabelEl.textContent = copy.days({ days: next.days });
  };

  const render = (next: CountdownParts): void => {
    for (const unit of UNITS) {
      const pair = reels[unit];
      const value = next[unit];
      const previous = parts[unit];

      pair.forEach((reel, i) => {
        if (value[i] === previous[i]) return;

        setDigit(reel, Number(value[i] ?? '0'));
      });
    }

    renderDays(next);

    // No lower bound. Clearing this at zero would put the hours and minutes
    // tiles back for the beat between the clock running out and the navigation
    // leaving, which reads as the page breaking at the one moment it is being
    // watched.
    root.classList.toggle(FINAL_MINUTE_CLASS, next.totalMs < FINAL_MINUTE_MS);

    parts = next;
  };

  const tick = (): void => {
    const remaining = remainingNow();

    render(splitCountdown(remaining));

    if (remaining > 0 || opened) return;

    opened = true;
    window.clearInterval(timer);

    onOpen();
  };

  /** Idempotent: a duplicate wake cannot leave two intervals running. */
  const start = (): void => {
    window.clearInterval(timer);

    // Drawn before the interval is armed, and so on every wake too. Waiting for
    // the first interval shows a stale value for up to a second and then rolls
    // it by however long the phone was asleep, which reads worse than frozen.
    tick();

    if (!opened) timer = window.setInterval(tick, TICK_MS);
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

/**
 * Swaps every server-rendered digit for a reel parked on the same glyph.
 *
 * @param root - The countdown container.
 * @param parts - The reading currently in the markup.
 * @returns Two reels per unit, left to right.
 */
const mountReels = (
  root: HTMLElement,
  parts: CountdownParts,
): Record<Unit, DigitReel[]> => {
  const mountUnit = (unit: Unit): DigitReel[] => {
    const cells = root.querySelectorAll<HTMLElement>(
      `[data-unit="${unit}"] .landing-digit`,
    );

    return [...cells].map((cell, i) =>
      mountDigit(cell, Number(parts[unit][i] ?? '0')),
    );
  };

  return {
    hours: mountUnit('hours'),
    minutes: mountUnit('minutes'),
    seconds: mountUnit('seconds'),
  };
};
