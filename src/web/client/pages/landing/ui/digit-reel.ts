import { prefersReducedMotion } from '../../../modules/ui/animations.ts';

/**
 * One digit, as a vertical reel of glyphs behind a one-line window.
 *
 * The technique is lifted from `pages/attendee/raffle/ui/roll.ts`, whose JSDoc
 * makes the argument this whole treatment rests on: writing a new number into
 * one element on a timer never moves anything, because every frame is an
 * unrelated glyph appearing in place of the last. That reads as flicker. A
 * strip translated behind a window is a thing in motion.
 *
 * **Not shared with that module, deliberately.** A second consumer is normally
 * the moment to promote shared code — the rule `pass/ui/front-clock.ts`
 * states for itself — but `roll.ts` is a 2500 ms four-revolution spin driven
 * from module-level singleton state, built for one stage per page. This needs
 * six independent reels stepping one position a second. Reconciling them means
 * refactoring a surface that runs live in front of a room, for a generalisation
 * neither page can use. If a third consumer appears, promote then: there will
 * be two implementations to generalise from rather than one to guess at.
 *
 * **Driven by WAAPI rather than by keyframes**, for the reason `roll.ts` and
 * `components/window-ring.css` both record: the reduced-motion block in
 * `base/reset.css` caps every CSS animation to 0.01ms and one iteration, which
 * parks a keyframed slide on a frame rather than skipping it. Scripted motion
 * is untouched by that reset, so this asks about the preference itself.
 */

/**
 * Glyphs on a strip, in the order a counting-down digit meets them.
 *
 * Descending, so the common case — any digit losing one — is a single step
 * forward. Ascending would make every ordinary tick a nine-step journey
 * backwards.
 */
const DIGITS = '9876543210';

/**
 * Revolutions on a strip.
 *
 * Two, and the second is load-bearing rather than slack. A reel rests anywhere
 * up to index 9 and travels a forward delta of up to 9, so the deepest landing
 * is index 18. One revolution would end the strip at 9 and paint blank through
 * the landing of a day boundary.
 */
const REVOLUTIONS = 2;

/** How long a reel takes to reach its digit. */
const ROLL_MS = 320;

/**
 * Near-linear with a late brake, so the glyph arrives somewhere rather than
 * easing to a halt. Shallower than the raffle's curve because this journey is
 * one position rather than forty.
 */
const ROLL_EASING = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

/** A mounted reel: its strip, and which index is currently in the window. */
export interface DigitReel {
  strip: HTMLElement;

  /** Index of the glyph in the window, always `0..9` at rest. */
  offset: number;

  /** The roll in flight, so a tick arriving mid-roll can cut it short. */
  animation?: Animation | undefined;
}

/**
 * Index on the strip that shows a digit, within the first revolution.
 *
 * @param digit - The digit to show.
 */
const indexOf = (digit: number): number => 9 - digit;

/** Parks a strip on one of its indices with no animation. */
const park = (reel: DigitReel, index: number): void => {
  reel.offset = index;
  reel.strip.style.transform = `translateY(-${String(index)}em)`;
};

/**
 * Replaces an element's content with a reel parked on the digit it was showing.
 *
 * The server renders each digit as a bare glyph, so a page whose script never
 * runs still shows the right number. Mounting swaps in the strip at the same
 * position, which is why hydration is invisible — the same glyph stays in the
 * same place. `mountReels` in `roll.ts` does this for the same reason.
 *
 * @param el - The digit's window element, holding the server-rendered glyph.
 * @param digit - The digit it is currently showing.
 * @returns The mounted reel.
 */
export const mountDigit = (el: HTMLElement, digit: number): DigitReel => {
  const strip = document.createElement('span');
  strip.className = 'landing-digit-strip';

  strip.append(
    ...Array.from({ length: DIGITS.length * REVOLUTIONS }, (_, i) => {
      const cell = document.createElement('span');
      cell.textContent = DIGITS[i % DIGITS.length] ?? '0';

      return cell;
    }),
  );

  const reel: DigitReel = { strip, offset: 0 };

  park(reel, indexOf(digit));
  el.replaceChildren(strip);

  return reel;
};

/**
 * Rolls a reel to a digit.
 *
 * Travels forward only, by the same modular delta `roll.ts:spin` computes. A
 * countdown almost always moves one position, but an hours field going `00` to
 * `23` at a day boundary moves eight — the general form has no edge case to
 * miss, and it costs one line over assuming a single step.
 *
 * @param reel - The reel to roll.
 * @param digit - The digit to land on.
 */
export const setDigit = (reel: DigitReel, digit: number): void => {
  const target = indexOf(digit);

  // A tick can arrive while the last roll is still settling — a phone waking
  // mid-animation, or a second boundary landing inside the 320ms. Cancelling
  // first drops that animation's fill, so `offset` is the truth again.
  reel.animation?.cancel();
  reel.animation = undefined;

  const delta = (((target - reel.offset) % 10) + 10) % 10;

  if (delta === 0) return;

  const end = reel.offset + delta;

  if (prefersReducedMotion()) {
    park(reel, target);
    return;
  }

  const animation = reel.strip.animate(
    [
      { transform: `translateY(-${String(reel.offset)}em)` },
      { transform: `translateY(-${String(end)}em)` },
    ],
    { duration: ROLL_MS, easing: ROLL_EASING, fill: 'both' },
  );

  reel.animation = animation;
  reel.strip.classList.add('is-rolling');

  void animation.finished
    .then(() => {
      // Parked back inside the first revolution before the fill is dropped.
      // Index `i` and `i + 10` show the identical glyph, so this is invisible,
      // and it is what keeps a finite strip good for an indefinite countdown.
      park(reel, target);
      animation.cancel();

      reel.animation = undefined;
      reel.strip.classList.remove('is-rolling');
    })
    .catch(() => {
      // `cancel()` rejects `finished`. That is the branch above cutting a roll
      // short, which has already parked the reel — there is nothing to repair.
    });
};
