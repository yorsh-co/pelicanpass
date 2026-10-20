import { PALETTE, TILE_RADIUS } from './palette.ts';

/** A point on the 100-unit design grid. */
export interface Point {
  x: number;
  y: number;
}

/** Fills for the mark's three parts. */
export interface MarkColours {
  /** Neck and head. */
  body: string;
  beak: string;
  eye: string;
}

/** The default colourway: white on Harbour, Pouch beak. */
export const ON_HARBOUR: MarkColours = {
  body: PALETTE.white,
  beak: PALETTE.pouch,
  eye: PALETTE.harbour,
};

/** Construction constants of the Pelican P, on the 100-unit grid. */
export const NECK = { x: 22, y: 24, width: 16, height: 64, rx: 8 } as const;
export const BEAK = {
  start: { x: 56, y: 17 },
  tip: { x: 92, y: 40 },
  control: { x: 72, y: 66 },
  end: { x: 44, y: 50 },
} as const;
export const HEAD = { cx: 42, cy: 30, r: 20 } as const;
export const EYE = { cx: 46, cy: 25, r: 3.6 } as const;

const n = (value: number): string => String(value);

/** A self-closing SVG element. */
const el = (tag: string, attributes: Record<string, string | number>): string =>
  `<${tag} ${Object.entries(attributes)
    .map(([name, value]) => `${name}="${String(value)}"`)
    .join(' ')}/>`;

/** Moves the glyph's optical centre onto the grid's centre. */
const CENTRE = { x: 57, y: 49 } as const;

/**
 * The mark's shapes in paint order: the head covers the root of the beak.
 *
 * @param scale - The mark's `S` value.
 * @param options - Colourway, and whether to draw the eye (omit it at 16 px).
 * @returns A `<g>` element centred on the 100-unit grid.
 */
export const markGroup = (
  scale: number,
  {
    colours = ON_HARBOUR,
    eye = true,
  }: { colours?: MarkColours; eye?: boolean } = {},
): string => {
  const { start, tip, control, end } = BEAK;
  const beak = `M${n(start.x)} ${n(start.y)}L${n(tip.x)} ${n(tip.y)}Q${n(control.x)} ${n(control.y)} ${n(end.x)} ${n(end.y)}Z`;
  const shapes = [
    el('rect', { ...NECK, fill: colours.body }),
    el('path', { d: beak, fill: colours.beak }),
    el('circle', { ...HEAD, fill: colours.body }),
  ];
  if (eye) {
    shapes.push(el('circle', { ...EYE, fill: colours.eye }));
  }
  return `<g transform="translate(50 50) scale(${n(scale)}) translate(-${n(CENTRE.x)} -${n(CENTRE.y)})">${shapes.join('')}</g>`;
};

/**
 * Maps a point of the construction onto the 100-unit grid.
 *
 * @param point - Point in construction coordinates.
 * @param scale - The mark's `S` value.
 * @returns The point after the group's transform.
 */
export const placeOnGrid = (point: Point, scale: number): Point => ({
  x: 50 + (point.x - CENTRE.x) * scale,
  y: 50 + (point.y - CENTRE.y) * scale,
});

/** Samples of a circle's boundary. */
const circle = (cx: number, cy: number, r: number, steps = 360): Point[] =>
  Array.from({ length: steps }, (_, i) => {
    const angle = (2 * Math.PI * i) / steps;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });

/**
 * A dense sampling of the mark's outline in construction coordinates: the
 * neck's rounded corners, the head, and the beak's edges and curve.
 *
 * @returns Points whose extremes are the glyph's extremes.
 */
export const markOutline = (): Point[] => {
  const { x, y, width, height, rx } = NECK;
  const centres: [number, number][] = [
    [x + rx, y + rx],
    [x + width - rx, y + rx],
    [x + rx, y + height - rx],
    [x + width - rx, y + height - rx],
  ];
  const corners = centres.flatMap(([cx, cy]) => circle(cx, cy, rx));

  const { start, tip, control, end } = BEAK;
  const curve = Array.from({ length: 101 }, (_, i) => {
    const t = i / 100;
    const u = 1 - t;
    return {
      x: u * u * tip.x + 2 * u * t * control.x + t * t * end.x,
      y: u * u * tip.y + 2 * u * t * control.y + t * t * end.y,
    };
  });

  return [
    ...corners,
    ...circle(HEAD.cx, HEAD.cy, HEAD.r),
    start,
    tip,
    end,
    ...curve,
  ];
};

const svg = (viewBox: number, body: string, pixels?: number): string => {
  const size =
    pixels === undefined ? '' : ` width="${n(pixels)}" height="${n(pixels)}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(viewBox)} ${n(viewBox)}"${size}>${body}</svg>`;
};

/** Options shared by the icon renderers. */
export interface IconOptions {
  /** The mark's `S` value. */
  scale: number;
  /** Omit the eye (16 px renderings). */
  eye?: boolean;
  /** Edge of the viewBox; the 100-unit grid is scaled to fit. Default 100. */
  viewBox?: number;
  /** Rendered `width` and `height`, for rasterising at a target size. */
  pixels?: number;
}

const icon = (rounded: boolean, options: IconOptions): string => {
  const { scale, eye = true, viewBox = 100, pixels } = options;
  const radius = rounded ? ` rx="${n(TILE_RADIUS)}"` : '';
  const ground = `<rect width="100" height="100"${radius} fill="${PALETTE.harbour}"/>`;
  const body = ground + markGroup(scale, { eye });
  return svg(
    viewBox,
    viewBox === 100
      ? body
      : `<g transform="scale(${n(viewBox / 100)})">${body}</g>`,
    pixels,
  );
};

/**
 * Harbour tile with rounded corners (`rx` 22 on the 100 grid) and the mark.
 *
 * @param options - Mark scale and sizing.
 * @returns The SVG document.
 */
export const tileIcon = (options: IconOptions): string => icon(true, options);

/**
 * Harbour ground to the edges, no corner radius, for maskable and iOS icons.
 *
 * @param options - Mark scale and sizing.
 * @returns The SVG document.
 */
export const fullBleedIcon = (options: IconOptions): string =>
  icon(false, options);
