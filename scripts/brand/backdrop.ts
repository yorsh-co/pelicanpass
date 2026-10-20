import { BACKDROP_STOPS } from './palette.ts';

/** Size of the backdrop images. */
export const BACKDROP_SIZE = { width: 1080, height: 1920 } as const;

/**
 * The brand backdrop: a vertical gradient from Harbour to Abyss.
 *
 * @returns The SVG document, 1080 × 1920.
 */
export const backdropSvg = (): string => {
  const { width, height } = BACKDROP_SIZE;
  const stops = BACKDROP_STOPS.map(
    ({ offset, colour }) =>
      `<stop offset="${String(offset * 100)}%" stop-color="${colour}"/>`,
  ).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient></defs>` +
    `<rect width="${String(width)}" height="${String(height)}" fill="url(#g)"/></svg>`
  );
};
