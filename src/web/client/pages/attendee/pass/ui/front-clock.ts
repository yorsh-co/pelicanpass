import { qsOptional } from '../../../../layouts/main/dom.ts';
import { startWallClock } from '../../../../modules/ui/clock.ts';

/**
 * Keeps a moving clock on the front of the pass.
 *
 * A glance-level cue and nothing more. The front face is otherwise entirely
 * static — it renders once and never changes, which makes a screenshot of it
 * byte-identical to the live page — so a volunteer looking at a phone across
 * the counter has nothing on it to tell the two apart. A ticking seconds digit
 * is the cheapest thing that is not. A screen recording defeats it and so does
 * a reimplemented front end; the checks that have to hold are on the back,
 * where the code is signed and, where the band is enabled, the word rotates
 * against the volunteer's own.
 *
 * A text rewrite rather than anything animated. The reduced-motion block in
 * `base/reset.css` caps every animation at one iteration, which parks a looping
 * keyframe on its final frame — a sign of life that is frozen for exactly the
 * users least likely to report it is worse than none, which is the argument
 * `components/window-ring.css` already makes for the arc. Text is content, so
 * none of that reaches this.
 *
 * The device's own clock, for the reason written over `renderClock` in
 * `ui/pass.ts`: its job is to be visibly moving rather than to be right, and
 * the volunteer compares it against the phone in their own hand. There is also
 * nothing to ask for — `ui/live.ts` bought the rule that the QR is not polled
 * while the front is up at roughly 15 MB a minute of venue wifi, and a clock is
 * not what spends it again. The front's only request is the light status poll
 * in `ui/front-poll.ts`.
 *
 * Deliberately not folded into `startLive`. That one is built only when the
 * render seeded a pass, and its ticker is *stopped* while the front face is up:
 * a front clock driven from there would advance only while it was hidden, and
 * would not exist at all on the render most in need of a sign of life.
 *
 * The ticker itself is `startWallClock`, shared with the volunteer's screen for
 * the case where the band is off and it, too, has no loop to hang a tick on.
 */
export const startFrontClock = (): void => {
  // Optional for the reason every slot in `ui/pass.ts` is: one template serves
  // both pass pages, and a missing decoration should leave a gap rather than
  // take down the screen an attendee opens straight after checking in.
  const el = qsOptional('[data-pass="frontClock"]');

  if (!el) return;

  startWallClock(el);
};
