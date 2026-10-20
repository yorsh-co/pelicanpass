import { openSync } from 'fontkit';
import { fileURLToPath } from 'node:url';

import { markGroup, markOutline, placeOnGrid, ON_HARBOUR } from './mark.ts';
import { MARK_SCALE, PALETTE } from './palette.ts';

import type { Font, Glyph } from 'fontkit';

const FONT_PATH = fileURLToPath(
  new URL('./fonts/LibreFranklin[wght].ttf', import.meta.url),
);

/** `letter-spacing` of the wordmark, in em, applied after every glyph. */
const LETTER_SPACING_EM = -0.035;

/** Cap height of the wordmark next to the mark, on the mark's 100-unit box. */
const LOCKUP_CAP_HEIGHT = 48;
/** Gap between the mark's ink and the wordmark, on the same box. */
const LOCKUP_GAP = 8;

/** Margin kept clear on every side of the fitted content, in viewBox units. */
const MARGIN = 8;

/** Size of the secondary wordmark's viewBox; `wordmark.css` hard-codes it. */
export const SECONDARY_VIEWBOX = { width: 341, height: 75 } as const;
/** Size of the primary wordmark's viewBox. */
export const PRIMARY_VIEWBOX = { width: 506, height: 121 } as const;

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A glyph outline placed on the line, in font units with y up. */
interface PlacedGlyph {
  glyph: Glyph;
  x: number;
}

/** One word, laid out on a shared baseline. */
interface Word {
  glyphs: PlacedGlyph[];
  /** Pen position after the last glyph. */
  advance: number;
}

let fonts: Font | undefined;

const loadFont = (): Font => {
  if (fonts === undefined) {
    const font = openSync(FONT_PATH);
    if (!('getVariation' in font)) {
      throw new Error('Libre Franklin is not a single variable font');
    }
    fonts = font;
  }
  return fonts;
};

/**
 * Lays out `text` at a weight, with the font's kerning and the wordmark's
 * letter-spacing.
 */
const layoutWord = (text: string, weight: number, startX: number): Word => {
  const instance = loadFont().getVariation({ wght: weight });
  const spacing = LETTER_SPACING_EM * instance.unitsPerEm;
  const { glyphs, positions } = instance.layout(text);

  let pen = startX;
  const placed = glyphs.map((glyph, i) => {
    const position = positions[i];
    if (position === undefined) {
      throw new Error(`No position for glyph ${String(i)}`);
    }
    const item = { glyph, x: pen + position.xOffset };
    pen += position.xAdvance + spacing;
    return item;
  });
  return { glyphs: placed, advance: pen };
};

const wordBounds = (word: Word): Bounds => {
  const boxes = word.glyphs
    .filter(({ glyph }) => glyph.path.commands.length > 0)
    .map(({ glyph, x }) => ({
      minX: glyph.bbox.minX + x,
      minY: glyph.bbox.minY,
      maxX: glyph.bbox.maxX + x,
      maxY: glyph.bbox.maxY,
    }));
  return {
    minX: Math.min(...boxes.map((b) => b.minX)),
    minY: Math.min(...boxes.map((b) => b.minY)),
    maxX: Math.max(...boxes.map((b) => b.maxX)),
    maxY: Math.max(...boxes.map((b) => b.maxY)),
  };
};

const round = (value: number): string => String(Number(value.toFixed(2)));

/** Finer rounding for transforms, whose error is multiplied by the content. */
const precise = (value: number): string => String(Number(value.toFixed(5)));

const PATH_LETTERS = {
  moveTo: 'M',
  lineTo: 'L',
  quadraticCurveTo: 'Q',
  bezierCurveTo: 'C',
} as const;

/**
 * Outlines a word as one SVG path, mapping font units (y up) to the target
 * (y down) as `x * scale + offsetX`, `offsetY - y * scale`.
 */
const wordPath = (
  word: Word,
  scale: number,
  offsetX: number,
  offsetY: number,
): string => {
  const px = (x: number, glyphX: number): string =>
    round(offsetX + (x + glyphX) * scale);
  const py = (y: number): string => round(offsetY - y * scale);

  return word.glyphs
    .flatMap(({ glyph, x }) =>
      glyph.path.commands.map(({ command, args }) =>
        command === 'closePath'
          ? 'Z'
          : PATH_LETTERS[command] +
            args
              .map((value, i) => (i % 2 === 0 ? px(value, x) : py(value)))
              .join(' '),
      ),
    )
    .join('');
};

/** "Pelican" at 800 followed by "Pass" at 400, on one baseline. */
const layoutWordmark = (): { pelican: Word; pass: Word } => {
  const pelican = layoutWord('Pelican', 800, 0);
  const pass = layoutWord('Pass', 400, pelican.advance);
  return { pelican, pass };
};

/** Uniform scale and offset that centre `box` in the viewBox, margin clear. */
const fit = (
  box: Bounds,
  viewBox: { width: number; height: number },
): { scale: number; dx: number; dy: number } => {
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const scale = Math.min(
    (viewBox.width - 2 * MARGIN) / width,
    (viewBox.height - 2 * MARGIN) / height,
  );
  return {
    scale,
    dx: (viewBox.width - width * scale) / 2 - box.minX * scale,
    dy: (viewBox.height - height * scale) / 2 - box.minY * scale,
  };
};

const open = (viewBox: { width: number; height: number }): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(viewBox.width)} ${String(viewBox.height)}">`;

/**
 * The secondary wordmark: "PelicanPass" outlined in one colour.
 *
 * It is drawn as a CSS mask, so only its alpha matters.
 *
 * @returns The SVG document, 341 × 75.
 */
export const secondaryWordmark = (): string => {
  const { pelican, pass } = layoutWordmark();
  const a = wordBounds(pelican);
  const b = wordBounds(pass);
  const box = {
    minX: a.minX,
    maxX: b.maxX,
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
  };
  // Font y is up; the fitted box is measured y-down from the top of the ink.
  const { scale, dx, dy } = fit(
    { ...box, minY: -box.maxY, maxY: -box.minY },
    SECONDARY_VIEWBOX,
  );
  const d = [pelican, pass]
    .map((word) => wordPath(word, scale, dx, dy))
    .join('');
  return `${open(SECONDARY_VIEWBOX)}<path d="${d}" fill="${PALETTE.white}"/></svg>`;
};

/**
 * The primary wordmark: the mark (`S` 0.92) and "PelicanPass" on one line, in
 * the on-Harbour colourway with "Pass" in Shallows.
 *
 * @returns The SVG document, 506 × 121, with no ground.
 */
export const primaryWordmark = (): string => {
  const { pelican, pass } = layoutWordmark();
  const a = wordBounds(pelican);
  const b = wordBounds(pass);
  const capHeight = loadFont().capHeight;
  const unit = LOCKUP_CAP_HEIGHT / capHeight;

  // Lockup space: the mark's 100-unit box at the origin, y down, text to its
  // right with its cap height centred on the box's centre line.
  const outline = markOutline().map((p) => placeOnGrid(p, MARK_SCALE.lockup));
  const markRight = Math.max(...outline.map((p) => p.x));
  const textX = markRight + LOCKUP_GAP - a.minX * unit;
  const baseline = 50 + LOCKUP_CAP_HEIGHT / 2;

  const box: Bounds = {
    minX: Math.min(...outline.map((p) => p.x)),
    maxX: textX + b.maxX * unit,
    minY: Math.min(
      ...outline.map((p) => p.y),
      baseline - Math.max(a.maxY, b.maxY) * unit,
    ),
    maxY: Math.max(
      ...outline.map((p) => p.y),
      baseline - Math.min(a.minY, b.minY) * unit,
    ),
  };
  const { scale, dx, dy } = fit(box, PRIMARY_VIEWBOX);

  const text = (word: Word, fill: string): string =>
    `<path d="${wordPath(word, unit * scale, textX * scale + dx, baseline * scale + dy)}" fill="${fill}"/>`;

  return (
    open(PRIMARY_VIEWBOX) +
    `<g transform="translate(${precise(dx)} ${precise(dy)}) scale(${precise(scale)})">` +
    markGroup(MARK_SCALE.lockup, { colours: ON_HARBOUR }) +
    '</g>' +
    text(pelican, PALETTE.white) +
    text(pass, PALETTE.shallows) +
    '</svg>'
  );
};
