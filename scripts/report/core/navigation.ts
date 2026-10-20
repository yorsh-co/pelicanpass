/** Size of the slide canvas; every slide dimension is in these pixels. */
export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;

/** Direction of a navigation request. */
export type NavAction = 'next' | 'prev' | 'first' | 'last';

const HASH_PREFIX = 'apresentacao-';

const KEY_ACTIONS = new Map<string, NavAction>([
  ['ArrowRight', 'next'],
  ['PageDown', 'next'],
  [' ', 'next'],
  ['Enter', 'next'],
  ['ArrowLeft', 'prev'],
  ['PageUp', 'prev'],
  ['Backspace', 'prev'],
  ['Home', 'first'],
  ['End', 'last'],
]);

/** Maps a `KeyboardEvent.key` to a navigation action, or `null`. */
export const actionForKey = (key: string): NavAction | null =>
  KEY_ACTIONS.get(key) ?? null;

/**
 * Decides what a click on the slide does: the left third goes back, the rest
 * goes forward.
 *
 * @param x - Pointer position, in the same unit as `left` and `width`.
 * @param left - Left edge of the slide.
 * @param width - Width of the slide.
 */
export const actionForClick = (
  x: number,
  left: number,
  width: number,
): 'next' | 'prev' => (x - left < width / 3 ? 'prev' : 'next');

/**
 * Reads the zero-based slide index from a URL hash such as
 * `#apresentacao-3`. The index is not clamped: the deck decides its length.
 *
 * @returns The index, or `null` when the hash is not a presentation link.
 */
export const slideFromHash = (hash: string): number | null => {
  const match = new RegExp(`^#?${HASH_PREFIX}(\\d+)$`).exec(hash);
  const number = match?.[1] === undefined ? 0 : Number(match[1]);

  return number >= 1 ? number - 1 : null;
};

/** The URL hash of a zero-based slide index. */
export const slideHash = (index: number): string =>
  `#${HASH_PREFIX}${String(index + 1)}`;

/** Keeps `index` inside a deck of `count` slides. */
export const clampSlide = (index: number, count: number): number =>
  Math.max(0, Math.min(index, count - 1));

/**
 * Applies a navigation action.
 *
 * @returns The new index; the same one at either end of the deck.
 */
export const navigate = (
  action: NavAction,
  index: number,
  count: number,
): number => {
  switch (action) {
    case 'next':
      return clampSlide(index + 1, count);
    case 'prev':
      return clampSlide(index - 1, count);
    case 'first':
      return 0;
    case 'last':
      return count - 1;
  }
};

/** Scale that fits the slide canvas inside a viewport. */
export const fitScale = (width: number, height: number): number =>
  Math.min(width / SLIDE_WIDTH, height / SLIDE_HEIGHT);
