import qrcode from 'qrcode-generator';

/** Quiet zone around the symbol, in modules. */
const QUIET_ZONE = 4;

/**
 * Renders a payload as the SVG data URI the pass shows.
 *
 * The server's `renderPassQr` in `src/modules/pass/pass.qr.ts` makes the same
 * symbol, but encodes the data URI with `Buffer`, which the browser lacks. The
 * markup is ASCII, so `btoa` is enough here.
 *
 * @param payload - Text to encode.
 * @returns A `data:image/svg+xml;base64,…` URI.
 */
export const passQr = (payload: string): string => {
  const qr = qrcode(0, 'M');

  qr.addData(payload);
  qr.make();

  const count = qr.getModuleCount();
  const side = String(count + QUIET_ZONE * 2);
  const origin = String(-QUIET_ZONE);
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

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${origin} ${origin} ${side} ${side}" shape-rendering="crispEdges">` +
    `<rect x="${origin}" y="${origin}" width="${side}" height="${side}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/>` +
    `</svg>`;

  return `data:image/svg+xml;base64,${btoa(svg)}`;
};
