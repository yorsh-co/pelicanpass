import qrcode from 'qrcode-generator';

/**
 * Quiet zone around the symbol, in modules.
 */
const QUIET_ZONE = 4;

/**
 * Builds the `d` attribute covering every dark module.
 *
 * One path for the whole symbol, with horizontal runs collapsed into single
 * commands. The library's own `createSvgTag` emits one `<rect>` per dark
 * module, which for a 53×53 symbol is 1,413 elements and a **51 KB** data URI;
 * the same modules as one run-length path come to **12 KB**. That difference is
 * paid on every poll by every phone in the room, which is the whole reason this
 * function exists rather than a one-line call to the library.
 *
 * @param qr - A QR code that has already had `make()` called on it.
 * @param count - Module count per side, from `getModuleCount()`.
 * @returns An SVG path definition in module coordinates.
 */
const buildPath = (qr: ReturnType<typeof qrcode>, count: number): string => {
  let path = '';

  for (let row = 0; row < count; row += 1) {
    let col = 0;

    while (col < count) {
      if (!qr.isDark(row, col)) {
        col += 1;
        continue;
      }

      let run = 0;
      while (col + run < count && qr.isDark(row, col + run)) run += 1;

      path += `M${String(col)} ${String(row)}h${String(run)}v1h-${String(run)}z`;
      col += run;
    }
  }

  return path;
};

/**
 * Renders a pass token as an SVG data URI.
 *
 * SVG rather than a canvas or a PNG: it is a string, so nothing here touches a
 * DOM or an image encoder, and it scales to whatever box the pass gives it
 * without a second size to keep in step.
 *
 * The result is set as an `<img src>`, which keeps the markup out of
 * `innerHTML` entirely. Admitted by Helmet's default `img-src 'self' data:`.
 * Base64 rather than percent-encoding: it measured ~25% larger, but it cannot
 * be broken by a quote or a `#` reaching an attribute, and a QR that renders
 * as nothing is not worth the kilobyte.
 *
 * @param token - Pass token from `issuePassToken`.
 * @returns A `data:image/svg+xml;base64,…` URI.
 */
export const renderPassQr = (token: string): string => {
  // Type 0 sizes the symbol to the payload. Correction level M is the usual
  // trade — a pass is scanned from a phone screen held still, not from a
  // creased poster, so the higher levels only cost modules.
  const qr = qrcode(0, 'M');

  qr.addData(token);
  qr.make();

  const count = qr.getModuleCount();
  const side = count + QUIET_ZONE * 2;
  const origin = String(-QUIET_ZONE);

  // No width or height, so the pass sizes it with CSS. `crispEdges` stops the
  // renderer antialiasing module boundaries into grey at small sizes, which is
  // what makes a scan fail on a low-brightness screen.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${origin} ${origin} ${String(side)} ${String(side)}" shape-rendering="crispEdges">` +
    `<rect x="${origin}" y="${origin}" width="${String(side)}" height="${String(side)}" fill="#fff"/>` +
    `<path d="${buildPath(qr, count)}" fill="#000"/>` +
    `</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
};
