import { prefersReducedMotion } from '../../../../modules/ui/animations.ts';
import { RAFFLE_ROLL_MS } from '../../../../modules/ui/pacing.ts';

/**
 * The rolling number, as one vertical reel per digit.
 *
 * The winner is already decided when this runs — the server chose it and the
 * response carried it here. This is theatre over a settled result, which is the
 * only honest way to animate a draw: the alternative is a client that picks,
 * and a client that picks is a client that can be made to pick.
 *
 * **Reels rather than a changing string.** Writing a new number into one element
 * on a timer never moves anything: every frame is an unrelated number appearing
 * in place of the last, which reads as flicker rather than as a machine. A strip
 * of glyphs translated behind a one-line window is a thing in motion, and
 * handing the whole journey to the Web Animations API means the browser
 * interpolates and composites it — every frame a new position, none of them
 * costing JavaScript.
 *
 * **Driven by WAAPI rather than by keyframes.** The reduced motion block in
 * `base/reset.css` caps every CSS animation to `0.01ms` and one iteration, which
 * would leave a keyframed spin parked on its first frame rather than skipped —
 * the same trap `components/window-ring.css` documents for the depleting arc.
 * Scripted motion is untouched by that reset, so this asks about the preference
 * itself.
 */

/** Digits on a reel, in the order they pass the window. */
const DIGITS = '0123456789';

/**
 * Full revolutions before a reel starts braking.
 *
 * Four is enough that the digits are a blur rather than a countable sequence.
 */
const SPIN_CYCLES = 4;

/**
 * Glyphs on a strip.
 *
 * Two spare revolutions beyond `SPIN_CYCLES`, not one, and the margin is load
 * bearing. A reel starts from wherever it last rested (up to 9) and travels
 * `SPIN_CYCLES * 10` plus a forward delta of up to 9, so the deepest landing is
 * `SPIN_CYCLES * 10 + 18` — then the overshoot adds a fraction and the window
 * itself is another `1em` tall. The worst case is a reel resting on 9 spinning
 * to 8, which reaches 59.18em: one revolution of spare would end the strip at
 * 49 and paint blank through the landing.
 */
const STRIP_GLYPHS = (SPIN_CYCLES + 2) * 10;

/** Gap between one reel landing and the next, in ms. */
const REEL_STAGGER_MS = 220;

/**
 * How far a reel runs past its digit before settling back, in `em`.
 *
 * An explicit keyframe rather than a springy easing. `--ease-spring` overshoots
 * by a *proportion* of the travel, and the travel here is tens of `em` — it
 * would fling the reel a third of a screen past its target. Overshoot on a long
 * journey has to be absolute.
 */
const OVERSHOOT_EM = 0.18;

/** Peak blur while a reel is at speed, in px. */
const BLUR_PX = 3;

/**
 * Near-constant speed for most of the spin, braking late.
 *
 * A gentler curve reads as the animation running out of budget rather than as
 * the reel arriving somewhere.
 */
const SPIN_EASING = 'cubic-bezier(0.12, 0.78, 0.16, 0.3)';

/** Set while the reels are in motion; the stylesheet hangs the mask and glow on it. */
const SPINNING_CLASS = 'is-spinning';

/** Set as the last reel lands; fires the landing keyframe and the ring. */
const LANDED_CLASS = 'is-drawn';

/**
 * Formats a check-in number the way every other surface writes it.
 *
 * **Unpadded, deliberately.** The reels zero-pad to a fixed width so the stage
 * never reflows, but that padding is a property of the machine and not of the
 * number: the drawn list, the screen-reader announcement and the attendee's own
 * pass all say `#8`. Only the reels say `008`.
 *
 * @param value - The number.
 */
export const formatNumber = (value: number): string => `#${String(value)}`;

/** A reel's strip, and where it is currently resting. */
interface Reel {
  strip: HTMLElement;

  /** Index of the glyph in the window, always `0..9`. */
  offset: number;
}

/** The reels currently mounted, left to right. */
let reels: Reel[] = [];

/** The element they were mounted into, so a remount can tell it is the same one. */
let mountedIn: HTMLElement | null = null;

/** Builds one reel's strip: enough repeats of `0-9` to cover the longest spin. */
const buildStrip = (): HTMLElement => {
  const strip = document.createElement('span');
  strip.className = 'raffle-reel-strip';

  strip.append(
    ...Array.from({ length: STRIP_GLYPHS }, (_, i) => {
      const cell = document.createElement('span');
      cell.textContent = DIGITS[i % 10] ?? '0';

      return cell;
    }),
  );

  return strip;
};

/** Parks a strip on one of its digits with no animation. */
const park = (reel: Reel, digit: number): void => {
  reel.offset = digit;
  reel.strip.style.transform = `translateY(-${String(digit)}em)`;
};

/**
 * Builds the reels, or leaves them alone if they are already the right shape.
 *
 * Called on every render rather than once at startup: `poolMax` grows as people
 * check in, and a pool crossing from 99 to 100 needs a third reel. Idempotent,
 * so the common case — same count, same element — costs a comparison.
 *
 * @param el - The stage element the reels live inside.
 * @param digitCount - How many reels to show, from the widest number in the pool.
 */
export const mountReels = (el: HTMLElement, digitCount: number): void => {
  // A pool of nothing still renders a machine, it just renders the smallest
  // one. Without the floor an empty pool would mount zero reels and the stage
  // would collapse.
  const count = Math.max(1, digitCount);

  if (mountedIn === el && reels.length === count) return;

  const wrap = document.createElement('span');
  wrap.className = 'raffle-reels';

  reels = Array.from({ length: count }, () => {
    const window_ = document.createElement('span');
    window_.className = 'raffle-reel';

    const strip = buildStrip();
    window_.append(strip);
    wrap.append(window_);

    const reel: Reel = { strip, offset: 0 };
    park(reel, 0);

    return reel;
  });

  mountedIn = el;
  el.replaceChildren(wrap);
};

/**
 * Spins one reel to a digit and resolves when it has settled.
 *
 * @param reel - The reel to spin.
 * @param digit - The digit to land on.
 * @param duration - How long this reel's journey takes.
 */
const spin = (reel: Reel, digit: number, duration: number): Promise<void> => {
  const start = reel.offset;

  // Forward distance to the digit, so a reel never runs backwards to reach it.
  const delta = (((digit - start) % 10) + 10) % 10;
  const distance = SPIN_CYCLES * 10 + delta;

  const end = start + distance;

  const animation = reel.strip.animate(
    [
      {
        offset: 0,
        transform: `translateY(-${String(start)}em)`,
        filter: 'blur(0px)',
      },
      { offset: 0.06, filter: `blur(${String(BLUR_PX)}px)` },
      { offset: 0.75, filter: `blur(${String(BLUR_PX * 0.6)}px)` },
      {
        offset: 0.9,
        transform: `translateY(-${String(end + OVERSHOOT_EM)}em)`,
      },
      {
        offset: 1,
        transform: `translateY(-${String(end)}em)`,
        filter: 'blur(0px)',
      },
    ],
    { duration, easing: SPIN_EASING, fill: 'both' },
  );

  return animation.finished.then(() => {
    // Parked back inside the first revolution before the animation's own fill is
    // dropped. Position `digit` and position `10k + digit` show the identical
    // glyph, so this is invisible — and it is what keeps a strip finite across
    // an evening of draws instead of having to grow without bound.
    park(reel, digit);
    animation.cancel();
  });
};

/**
 * Rolls the stage up to a winning number.
 *
 * Resolves once the last reel has settled, so the caller can hold the button in
 * its busy state for exactly as long as the animation runs rather than guessing
 * at a matching timeout.
 *
 * @param el - The stage element. Must have been through {@link mountReels}.
 * @param winner - The number to land on.
 * @returns A promise that settles once the number is on screen.
 */
export const rollTo = async (
  el: HTMLElement,
  winner: number,
): Promise<void> => {
  // Truncated from the left rather than widened if the winner somehow outgrows
  // the mounted width: the reels are sized from `poolMax`, so this can only
  // happen if the pool shrank under us, and showing the low digits beats
  // throwing on a stage.
  const digits = String(winner)
    .padStart(reels.length, '0')
    .slice(-reels.length)
    .split('')
    .map(Number);

  el.classList.remove(LANDED_CLASS);

  const land = (): void => {
    el.classList.remove(SPINNING_CLASS);

    // Reflow between removing and adding, so a second draw replays the keyframe:
    // an animation whose class is already present does not restart on its own.
    void el.offsetWidth;
    el.classList.add(LANDED_CLASS);
  };

  if (prefersReducedMotion()) {
    digits.forEach((digit, i) => {
      const reel = reels[i];
      if (reel) park(reel, digit);
    });

    land();

    return;
  }

  el.classList.add(SPINNING_CLASS);

  await Promise.all(
    digits.map((digit, i) => {
      const reel = reels[i];
      if (!reel) return Promise.resolve();

      // Leftmost lands first, so the tension runs toward the last digit.
      const duration =
        RAFFLE_ROLL_MS - (reels.length - 1 - i) * REEL_STAGGER_MS;

      return spin(reel, digit, duration);
    }),
  );

  land();
};
