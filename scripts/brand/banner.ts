import { TILE_RADIUS, PALETTE } from './palette.ts';
import { PRIMARY_VIEWBOX, primaryWordmark } from './wordmark.ts';

/** Size of the README banner's viewBox. */
export const BANNER_VIEWBOX = { width: 1280, height: 320 } as const;

/** Width the primary wordmark is drawn at, in banner units. */
const WORDMARK_WIDTH = 760;

/**
 * The README banner: the primary wordmark centred on a Harbour rounded
 * rectangle, so the on-Harbour colourway reads on light and dark pages alike.
 *
 * The wordmark is nested as an inner `<svg>`, so its geometry is the one in
 * `wordmark.ts` and is never duplicated.
 *
 * @returns The SVG document, 1280 × 320.
 */
export const bannerSvg = (): string => {
  const { width, height } = BANNER_VIEWBOX;
  const scale = WORDMARK_WIDTH / PRIMARY_VIEWBOX.width;
  const wordmarkHeight = PRIMARY_VIEWBOX.height * scale;
  const x = (width - WORDMARK_WIDTH) / 2;
  const y = (height - wordmarkHeight) / 2;
  const radius = (TILE_RADIUS / 100) * height;

  const wordmark = primaryWordmark().replace(
    '<svg ',
    `<svg x="${String(x)}" y="${String(Number(y.toFixed(2)))}" width="${String(WORDMARK_WIDTH)}" height="${String(Number(wordmarkHeight.toFixed(2)))}" `,
  );

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}">` +
    `<rect width="${String(width)}" height="${String(height)}" rx="${String(radius)}" fill="${PALETTE.harbour}"/>` +
    wordmark +
    '</svg>'
  );
};
