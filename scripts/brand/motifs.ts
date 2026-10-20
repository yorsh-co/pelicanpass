import { PALETTE } from './palette.ts';

const ring = (
  size: number,
  radius: number,
  stroke: string,
  strokeWidth: number,
  opacity?: number,
): string =>
  `<circle cx="${String(size / 2)}" cy="${String(size / 2)}" r="${String(radius)}" fill="none" stroke="${stroke}" stroke-width="${String(strokeWidth)}"${opacity === undefined ? '' : ` stroke-opacity="${String(opacity)}"`}/>`;

const motif = (size: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(size)} ${String(size)}">${body}</svg>`;

/**
 * `star-sm.svg`: one Pouch ring on a 155 × 155 canvas.
 *
 * @returns The SVG document.
 */
export const starSmSvg = (): string =>
  motif(155, ring(155, 70, PALETTE.pouch, 10));

/**
 * `star-with-discs.svg`: three concentric Shallows rings on a 615 × 615 canvas.
 *
 * @returns The SVG document.
 */
export const starWithDiscsSvg = (): string =>
  motif(
    615,
    (
      [
        [300, 0.1],
        [230, 0.14],
        [160, 0.18],
      ] as [number, number][]
    )
      .map(([radius, opacity]) =>
        ring(615, radius, PALETTE.shallows, 4, opacity),
      )
      .join(''),
  );
