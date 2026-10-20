import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import sharp from 'sharp';

import { buildBrand } from './build.ts';

const PNG_SIZES: Record<string, number> = {
  'assets/images/icon/icon-master-1024.png': 1024,
  'assets/images/icon/icon-512.png': 512,
  'assets/images/icon/icon-512-maskable.png': 512,
  'assets/images/icon/icon-192.png': 192,
  'assets/images/icon/apple-touch-icon.png': 180,
  'assets/images/icon/favicon-32x32.png': 32,
};

describe('buildBrand', () => {
  let outDir = '';
  let written = new Map<string, number>();

  before(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'brand-'));
    written = await buildBrand(outDir);
  });

  after(() => rm(outDir, { recursive: true, force: true }));

  const metadata = (file: string) => sharp(path.join(outDir, file)).metadata();

  it('writes every asset in brand.md', () => {
    assert.deepEqual(
      [...written.keys()].sort(),
      [
        ...Object.keys(PNG_SIZES),
        'assets/images/logo/wordmark-primary.svg',
        'assets/images/logo/wordmark-secondary.svg',
        'assets/images/icon/favicon.svg',
        'assets/images/bg/bg.png',
        'assets/images/bg/bg.webp',
        'assets/images/motifs/star-sm.svg',
        'assets/images/motifs/star-with-discs.svg',
        'favicon.ico',
      ].sort(),
    );
  });

  it('renders each icon PNG square at its size, with alpha', async () => {
    for (const [file, size] of Object.entries(PNG_SIZES)) {
      const { width, height, format, hasAlpha } = await metadata(file);

      assert.deepEqual(
        [width, height, format, hasAlpha],
        [size, size, 'png', true],
        file,
      );
    }
  });

  it('renders the backdrop at 1080 x 1920 in both formats', async () => {
    for (const [file, format] of [
      ['assets/images/bg/bg.png', 'png'],
      ['assets/images/bg/bg.webp', 'webp'],
    ] as const) {
      const meta = await metadata(file);

      assert.deepEqual(
        [meta.width, meta.height, meta.format],
        [1080, 1920, format],
        file,
      );
    }
  });

  it('packs 48 and 32 px PNGs into favicon.ico', async () => {
    const ico = await readFile(path.join(outDir, 'favicon.ico'));

    assert.equal(ico.readUInt16LE(4), 2);
    const sizes = [0, 1].map((i) => ico.readUInt8(6 + 16 * i));
    assert.deepEqual(sizes, [48, 32]);

    for (const [i, size] of [48, 32].entries()) {
      const length = ico.readUInt32LE(6 + 16 * i + 8);
      const offset = ico.readUInt32LE(6 + 16 * i + 12);
      const meta = await sharp(
        ico.subarray(offset, offset + length),
      ).metadata();

      assert.deepEqual(
        [meta.width, meta.height, meta.format],
        [size, size, 'png'],
      );
    }
  });

  it('sizes the SVGs by their viewBox', async () => {
    const viewBoxes: Record<string, string> = {
      'assets/images/logo/wordmark-primary.svg': '0 0 506 121',
      'assets/images/logo/wordmark-secondary.svg': '0 0 341 75',
      'assets/images/icon/favicon.svg': '0 0 1024 1024',
      'assets/images/motifs/star-sm.svg': '0 0 155 155',
      'assets/images/motifs/star-with-discs.svg': '0 0 615 615',
    };

    for (const [file, viewBox] of Object.entries(viewBoxes)) {
      const svg = await readFile(path.join(outDir, file), 'utf8');

      assert.ok(svg.includes(`viewBox="${viewBox}"`), file);
    }
  });
});
