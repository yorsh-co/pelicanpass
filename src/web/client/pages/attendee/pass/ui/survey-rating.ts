/**
 * The survey's rating control: a slider and a typed number box.
 *
 * The number box carries the form value; the slider is a quicker way to set
 * it. These helpers translate between what the attendee does and the integer
 * the box holds, and touch no DOM so they can be tested on their own.
 */

/**
 * Sideways travel, in pixels, before a touch counts as a drag. Below it the
 * touch may still become a vertical scroll of the dialog.
 */
const DRAG_SLOP = 6;

/**
 * Maps a pointer position over a horizontal track to the nearest rating.
 *
 * Positions outside the track clamp to the nearest end. A track with no width
 * has nothing to measure against and yields the minimum rather than `NaN`.
 *
 * @param clientX - The pointer's horizontal position, in viewport pixels.
 * @param left - The track's left edge, from its bounding rectangle.
 * @param width - The track's width, from its bounding rectangle.
 * @param min - The lowest rating.
 * @param max - The highest rating.
 * @returns An integer in `[min, max]`.
 */
export const ratingAt = (
  clientX: number,
  left: number,
  width: number,
  min: number,
  max: number,
): number => {
  if (!(width > 0)) return min;

  const fraction = Math.min(Math.max((clientX - left) / width, 0), 1);

  return Math.round(min + fraction * (max - min));
};

/**
 * Reads a rating out of what was typed in the number box.
 *
 * Only a plain whole number is accepted; decimals, signs, exponents and text
 * are not coerced into one.
 *
 * @param text - The box's current text.
 * @param min - The lowest rating.
 * @param max - The highest rating.
 * @returns The rating, or `null` when the text is not a whole number in range.
 */
export const parseRating = (
  text: string,
  min: number,
  max: number,
): number | null => {
  const trimmed = text.trim();

  if (!/^\d+$/.test(trimmed)) return null;

  const value = Number(trimmed);

  return value >= min && value <= max ? value : null;
};

/**
 * Whether what was typed in the number box is a number above the scale.
 *
 * Such an edit is refused as it is typed rather than left for the submit to
 * reject. Any number counts, not only whole ones, so `10.5` and `1e2` are
 * caught too. The lower bound is left to `reportValidity`: refusing a `0` here
 * would get in the way of typing.
 *
 * @param text - The box's current text.
 * @param max - The highest rating.
 */
export const exceedsMax = (text: string, max: number): boolean => {
  const trimmed = text.trim();
  const value = Number(trimmed);

  return trimmed !== '' && Number.isFinite(value) && value > max;
};

/**
 * Wires each rating question's slider and number box together.
 *
 * The number box is the form value, and the slider only a quicker way to set
 * it: the box carries the name, so `form.reportValidity` covers `required`,
 * `min`, `max` and `step` with the browser's own messages and nothing is
 * checked twice here, beyond refusing a number above the scale as it is
 * typed. The slider is unnamed and never submitted. An empty or invalid box
 * leaves the slider unset: a grey thumb resting at the centre, on a half step
 * so it sits between two ratings rather than on one. Nothing is preselected.
 *
 * Pointer Events as in `slide-confirm.ts`: `setPointerCapture` keeps a finger
 * that drifts off the line feeding the gesture. They are bound to the track,
 * whose `touch-action: pan-y` lets a vertical swipe on the line scroll the
 * dialog instead of starting a gesture. The native range still serves
 * keyboards and assistive technology through its `input` event, while
 * `pointerdown` is cancelled so its thumb does not fight this positioning.
 *
 * A native thumb's centre travels half its width in from each end of the
 * range, so the stylesheet publishes the thumb's width as `--rating-thumb` and
 * the gesture maps positions onto that inset span.
 *
 * @param form - The card's form.
 */
export const setupRatings = (form: HTMLFormElement): void => {
  for (const wrapper of form.querySelectorAll<HTMLElement>(
    '[data-survey="rating"]',
  )) {
    const track = wrapper.querySelector<HTMLElement>(
      '.pass-survey-rating-track',
    );
    const range = wrapper.querySelector<HTMLInputElement>(
      '[data-survey="rating-range"]',
    );
    const number = wrapper.querySelector<HTMLInputElement>(
      '[data-survey="rating-input"]',
    );

    if (!track || !range || !number) continue;

    const min = Number(number.min);
    const max = Number(number.max);

    let accepted = number.value;

    const paint = (value: number): void => {
      wrapper.removeAttribute('data-unset');
      // The step first, or the value would be snapped to the half-step grid.
      range.step = '1';
      range.value = String(value);
      range.setAttribute('aria-valuetext', String(value));
      wrapper.style.setProperty(
        '--rating-fill',
        String((value - min) / (max - min)),
      );
    };

    const unset = (): void => {
      wrapper.setAttribute('data-unset', '');
      range.step = '0.5';
      range.value = String((min + max) / 2);
      range.setAttribute('aria-valuetext', wrapper.dataset.unsetText ?? '');
      wrapper.style.removeProperty('--rating-fill');
    };

    const commit = (value: number): void => {
      number.value = String(value);
      accepted = number.value;
      paint(value);
    };

    let pointerId: number | null = null;
    let left = 0;
    let width = 0;
    let startX = 0;
    let startY = 0;
    let dragging = false;

    track.addEventListener('pointerdown', (event) => {
      // Primary button only, one pointer at a time.
      if (pointerId !== null || event.button !== 0) return;

      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;

      // Measured once per gesture rather than on every move.
      const rect = range.getBoundingClientRect();
      const thumbHalf =
        parseFloat(
          getComputedStyle(wrapper).getPropertyValue('--rating-thumb'),
        ) / 2 || 0;

      left = rect.left + thumbHalf;
      width = rect.width - 2 * thumbHalf;

      track.setPointerCapture(event.pointerId);

      // Cancelling the press also cancels the focus it would have given.
      event.preventDefault();
      range.focus({ preventScroll: true });

      // A mouse commits on press. A finger may be starting a scroll, so it
      // commits only once it moves sideways or lifts as a tap.
      dragging = event.pointerType === 'mouse';
      if (dragging) commit(ratingAt(event.clientX, left, width, min, max));
    });

    track.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;

      if (!dragging) {
        const dx = Math.abs(event.clientX - startX);
        const dy = Math.abs(event.clientY - startY);

        if (dx < DRAG_SLOP || dx <= dy) return;
        dragging = true;
      }

      commit(ratingAt(event.clientX, left, width, min, max));
    });

    /**
     * Ends the gesture. A lift that never turned into a drag is a tap and
     * commits where it landed; a `pointercancel` means the browser took the
     * touch for a scroll, and commits nothing.
     */
    const release = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return;

      if (event.type === 'pointerup' && !dragging) {
        commit(ratingAt(event.clientX, left, width, min, max));
      }

      pointerId = null;
      dragging = false;
    };

    track.addEventListener('pointerup', release);
    track.addEventListener('pointercancel', release);

    range.addEventListener('input', () => {
      commit(Number(range.value));
    });

    number.addEventListener('input', () => {
      if (exceedsMax(number.value, max)) {
        number.value = accepted;
        return;
      }

      accepted = number.value;

      const value = parseRating(number.value, min, max);

      if (value === null) unset();
      else paint(value);
    });
  }
};
