/**
 * How far along the track a release has to land to count as a confirmation.
 *
 * Two thirds rather than the whole width: reaching the end exactly is fiddly
 * one-handed, and anything past a screen's width of deliberate travel is
 * already impossible to produce by brushing the glass.
 */
const THRESHOLD = 0.65;

/** Keeps a value inside the track. */
const clamp = (value: number): number => Math.min(Math.max(value, 0), 1);

/**
 * Returns a control to its resting state.
 *
 * Exported because the confirmation is asynchronous: the fill is left standing
 * while the request is in flight — proof that the gesture took — and only the
 * caller knows when the answer has landed. A row left filled after a failure
 * cannot be slid again.
 *
 * @param button - The control to clear.
 */
export const resetSlide = (button: HTMLElement): void => {
  button.style.removeProperty('--slide');
  button.classList.remove('is-armed', 'is-sliding');
};

/**
 * Turns a button into a slide-to-confirm control.
 *
 * The button stays a button. A pointer has to drag it past {@link THRESHOLD}
 * and let go, but Enter, Space and an assistive-technology activation still
 * confirm outright — those users cannot slide, and requiring it of them would
 * be the accessibility bug rather than the guard.
 *
 * Pointer Events throughout rather than separate mouse and touch paths: one
 * code path, and `setPointerCapture` means a finger that wanders off the row
 * keeps feeding this element instead of silently ending the gesture. Supported
 * in every browser this app targets.
 *
 * The drag writes one number — `--slide`, 0 to 1 — and reads no layout after
 * the first measurement. Everything visible is the stylesheet's.
 *
 * @param button - The control to arm. Wire it only while it is actionable.
 * @param thumb - The travelling part, measured rather than assumed so its size
 *   is written in the stylesheet and nowhere else.
 * @param onConfirm - Run once, when a drag is released past the threshold or
 *   the button is activated without a pointer.
 */
export const setupSlideConfirm = (
  button: HTMLButtonElement,
  thumb: HTMLElement,
  onConfirm: () => void,
): void => {
  let pointerId: number | null = null;
  let startX = 0;
  let travel = 0;
  let progress = 0;

  /**
   * Whether a pointer gesture just answered this control.
   *
   * A tap produces `pointerdown`, `pointerup` and then a `click`, and that
   * click is the one thing standing between a stray brush and a recorded
   * handover. It is suppressed here and nowhere else, so every activation that
   * did *not* come from a pointer — a keyboard, a screen reader's double tap —
   * still reaches {@link onConfirm}.
   *
   * Set when a gesture ends, consumed by the click that follows it, and cleared
   * by the next `pointerdown` or `keydown` in case no click came. Never cleared
   * on a timer: iOS WebKit dispatches a tap's click after a zero-delay timeout
   * has already run, which let taps through as confirmations.
   */
  let handled = false;

  const paint = (value: number): void => {
    button.style.setProperty('--slide', String(value));
    button.classList.toggle('is-armed', value >= THRESHOLD);
  };

  button.addEventListener('pointerdown', (event) => {
    // Left button only, and one gesture at a time: a second finger landing
    // mid-drag would otherwise take over the maths halfway along the track.
    if (button.disabled || pointerId !== null || event.button !== 0) return;

    handled = false;
    pointerId = event.pointerId;
    startX = event.clientX;
    progress = 0;

    // Measured once. Reading it per move would be a layout flush on every
    // frame of a gesture that is meant to feel attached to the finger.
    //
    // `clientWidth`, not the bounding rect: the thumb's `left: 100%` resolves
    // against the containing block's *padding* box, and the row has a border,
    // so the rect's width would overstate the travel by those two pixels.
    travel = Math.max(button.clientWidth - thumb.offsetWidth, 1);

    button.setPointerCapture(event.pointerId);
    button.classList.add('is-sliding');
  });

  button.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;

    progress = clamp((event.clientX - startX) / travel);
    paint(progress);
  });

  /**
   * Ends the gesture, whether the finger lifted or the browser took it away.
   *
   * `pointercancel` shares this handler deliberately: a call arriving mid-drag
   * or the platform claiming the gesture has to leave the row reset rather than
   * stopped half-filled, which would read as a redemption in progress.
   */
  const end = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;

    pointerId = null;
    button.classList.remove('is-sliding');

    const confirmed = event.type === 'pointerup' && progress >= THRESHOLD;

    if (confirmed) {
      paint(1);
    } else {
      resetSlide(button);
    }

    handled = true;
    progress = 0;

    if (confirmed) onConfirm();
  };

  button.addEventListener('pointerup', end);
  button.addEventListener('pointercancel', end);

  // A drag released off the button produces no click, so the flag it leaves
  // standing must not swallow the keyboard activation that comes next.
  button.addEventListener('keydown', () => {
    handled = false;
  });

  button.addEventListener('click', () => {
    if (handled) {
      handled = false;
      return;
    }

    onConfirm();
  });
};
