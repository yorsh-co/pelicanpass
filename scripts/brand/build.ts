/**
 * Renders every brand asset listed in `docs/design/brand.md` into the web
 * root, at the paths, formats and pixel sizes the layouts and the manifest
 * already reference.
 *
 * Reproducible: the geometry comes from `palette.ts` and `mark.ts`, the
 * lettering from the Libre Franklin font in `fonts/`, and every raster is drawn
 * from its SVG at the target size rather than resampled from a master.
 *
 * Usage:
 *   node scripts/brand/build.ts                 writes src/web/public and
 *                                               docs/images/banner.svg
 *   node scripts/brand/build.ts --out <dir>     writes <dir> only
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { backdropSvg, BACKDROP_SIZE } from './backdrop.ts';
import { bannerSvg } from './banner.ts';
import { packIco } from './ico.ts';
import { fullBleedIcon, standaloneMark, tileIcon } from './mark.ts';
import { starWithDiscsSvg } from './motifs.ts';
import { MARK_SCALE } from './palette.ts';
import {
  primaryWordmark,
  secondaryWordmark,
  twoToneWordmark,
} from './wordmark.ts';

const DEFAULT_OUT_DIR = fileURLToPath(
  new URL('../../src/web/public', import.meta.url),
);

/** README banner; it is documentation, not a web asset. */
const BANNER_PATH = fileURLToPath(
  new URL('../../docs/images/banner.svg', import.meta.url),
);

const LOGO = 'assets/images/logo';
const ICON = 'assets/images/icon';
const BG = 'assets/images/bg';
const MOTIFS = 'assets/images/motifs';

/**
 * WebP quality of the backdrop. The gradient is smooth and spans only a few
 * dozen 8-bit levels, so lossy compression at lower qualities turns each level
 * boundary into a visible band; 95 keeps them as the PNG has them.
 */
const BACKDROP_WEBP_QUALITY = 95;

/** Renders an SVG document to an RGBA PNG at its own width and height. */
const rasterise = (svg: string): Promise<Buffer> =>
  sharp(Buffer.from(svg), { density: 72 })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();

const tilePng = (size: number, scale: number, eye = true): Promise<Buffer> =>
  rasterise(tileIcon({ scale, eye, pixels: size }));

const bleedPng = (size: number, scale: number): Promise<Buffer> =>
  rasterise(fullBleedIcon({ scale, pixels: size }));

/**
 * Writes every brand asset under `outDir`.
 *
 * @param outDir - Web root to write into; directories are created as needed.
 * @returns The files written, as paths relative to `outDir` with their sizes
 *   in bytes.
 */
export const buildBrand = async (
  outDir: string,
): Promise<Map<string, number>> => {
  const backdrop = backdropSvg();
  const files: [string, Buffer | string][] = [
    [`${LOGO}/wordmark-primary.svg`, primaryWordmark()],
    [`${LOGO}/wordmark-secondary.svg`, secondaryWordmark()],
    [`${LOGO}/wordmark-two-tone.svg`, twoToneWordmark()],
    [`${LOGO}/mark.svg`, standaloneMark()],
    [
      `${ICON}/favicon.svg`,
      tileIcon({ scale: MARK_SCALE.appIcon, viewBox: 1024 }),
    ],
    [`${ICON}/icon-master-1024.png`, await tilePng(1024, MARK_SCALE.appIcon)],
    [`${ICON}/icon-512.png`, await tilePng(512, MARK_SCALE.appIcon)],
    [`${ICON}/icon-512-maskable.png`, await bleedPng(512, MARK_SCALE.maskable)],
    [`${ICON}/icon-192.png`, await tilePng(192, MARK_SCALE.appIcon)],
    [
      `${ICON}/apple-touch-icon.png`,
      await bleedPng(180, MARK_SCALE.appleTouch),
    ],
    [`${ICON}/favicon-32x32.png`, await tilePng(32, MARK_SCALE.favicon32)],
    [
      'favicon.ico',
      packIco(
        await Promise.all(
          [48, 32].map(async (size) => ({
            size,
            png: await tilePng(size, MARK_SCALE.favicon32),
          })),
        ),
      ),
    ],
    [`${BG}/bg.png`, await rasterise(backdrop)],
    [
      `${BG}/bg.webp`,
      await sharp(Buffer.from(backdrop))
        .resize(BACKDROP_SIZE.width, BACKDROP_SIZE.height)
        .webp({ quality: BACKDROP_WEBP_QUALITY, effort: 6 })
        .toBuffer(),
    ],
    [`${MOTIFS}/star-with-discs.svg`, starWithDiscsSvg()],
  ];

  const written = new Map<string, number>();
  for (const [relative, content] of files) {
    const target = path.join(outDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    written.set(relative, Buffer.byteLength(content));
  }
  return written;
};

if (import.meta.main) {
  const flag = process.argv.indexOf('--out');
  const outArg = flag === -1 ? undefined : process.argv[flag + 1];

  if (flag !== -1 && (outArg === undefined || outArg.startsWith('--'))) {
    throw new Error('--out needs a directory');
  }

  const outDir = path.resolve(outArg ?? DEFAULT_OUT_DIR);
  for (const [relative, bytes] of await buildBrand(outDir)) {
    console.log(`${path.join(outDir, relative)} (${String(bytes)} bytes)`);
  }

  if (outArg === undefined) {
    const banner = bannerSvg();
    await mkdir(path.dirname(BANNER_PATH), { recursive: true });
    await writeFile(BANNER_PATH, banner);
    console.log(`${BANNER_PATH} (${String(Buffer.byteLength(banner))} bytes)`);
  }
}
