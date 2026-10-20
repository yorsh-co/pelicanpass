/**
 * Sizing of the square html5-qrcode decodes.
 *
 * The library reads only a `qrbox` centred in the video element, in CSS
 * pixels, so anything the viewfinder frames outside that square is never
 * decoded. The video box is sized one pixel to one CSS pixel and centred on the
 * viewfinder, which is what lets the drawn side stand in for the decoded one.
 *
 * Kept free of DOM access so it can be tested without a browser.
 */

/** Viewfinder side assumed when it could not be measured. */
export const DEFAULT_DECODE_SIDE = 220;

/** How far the decoded square extends past the brackets, as a multiple of them. */
export const DECODE_MARGIN = 1.2;

/** The smallest `qrbox` dimension html5-qrcode accepts; below it, it throws. */
export const MIN_DECODE_SIDE = 50;

/**
 * Side of the square to decode for a viewfinder of the given size.
 *
 * Raised to {@link MIN_DECODE_SIDE} first and capped to the video box last, so
 * the box wins when the two disagree: a `qrbox` wider than the box throws from
 * inside the library's `playing` listener, which silently stops scanning. A box
 * under the minimum cannot be scanned at all, and is not a size the full-screen
 * feed reaches.
 *
 * @param drawnSide - On-screen width of the viewfinder in CSS pixels. Anything
 *   that is not a positive finite number, such as an element that is missing or
 *   not yet laid out, falls back to {@link DEFAULT_DECODE_SIDE}.
 * @param boxWidth - Width of the video element's box.
 * @param boxHeight - Height of the video element's box.
 * @returns The side in whole pixels, never above the box's smaller side.
 */
export const decodeBoxSide = (
  drawnSide: number,
  boxWidth: number,
  boxHeight: number,
): number => {
  const side =
    Number.isFinite(drawnSide) && drawnSide > 0
      ? drawnSide
      : DEFAULT_DECODE_SIDE;

  const wanted = Math.max(Math.floor(side * DECODE_MARGIN), MIN_DECODE_SIDE);

  return Math.min(wanted, Math.floor(Math.min(boxWidth, boxHeight)));
};
