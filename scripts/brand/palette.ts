/**
 * The PelicanPass brand values, as set out in `docs/design/brand.md`. The guide
 * and this file describe the same numbers: change them together.
 */

/** Brand colours. */
export const PALETTE = {
  /** Backdrop, icon tile, the mark on light surfaces. */
  harbour: '#0E4A5A',
  /** End of the backdrop gradient. */
  abyss: '#072A33',
  /** The beak. */
  pouch: '#F5A524',
  /** "Pass" in the primary wordmark. */
  shallows: '#CFE6E8',
  /** Pouch at text weight on light surfaces. */
  pouchInk: '#9A5B00',
  /** The mark's neck and head on a dark ground. */
  white: '#FFFFFF',
} as const;

/** Gradient stops of the brand backdrop, top to bottom. */
export const BACKDROP_STOPS = [
  { offset: 0, colour: PALETTE.harbour },
  { offset: 0.6, colour: '#0B3B48' },
  { offset: 1, colour: PALETTE.abyss },
] as const;

/** The mark's scale `S` for each use. */
export const MARK_SCALE = {
  lockup: 0.92,
  standalone: 1.1,
  appIcon: 0.72,
  favicon32: 0.78,
  favicon16: 0.82,
  maskable: 0.64,
  appleTouch: 0.72,
} as const;

/** Corner radius of the icon tile on the 100-unit grid. */
export const TILE_RADIUS = 22;
