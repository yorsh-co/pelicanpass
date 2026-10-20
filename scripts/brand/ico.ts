/** Header sizes of the ICO container. */
const ICONDIR_SIZE = 6;
const ICONDIRENTRY_SIZE = 16;

/** One image of an icon file. */
export interface IcoImage {
  /** Width and height in pixels; images are square. 256 is the maximum. */
  size: number;
  /** The image as a PNG file. */
  png: Buffer;
}

/**
 * Packs PNG images into an ICO container.
 *
 * Each entry stores the PNG as is, which every browser reads; width and height
 * are one byte, so 256 is written as 0.
 *
 * @param images - Images in the order they should be listed.
 * @returns The ICO file.
 */
export const packIco = (images: readonly IcoImage[]): Buffer => {
  const header = Buffer.alloc(ICONDIR_SIZE + ICONDIRENTRY_SIZE * images.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) {
      throw new RangeError(`ICO images are 1 to 256 px, got ${String(size)}`);
    }
    const entry = ICONDIR_SIZE + ICONDIRENTRY_SIZE * i;
    header.writeUInt8(size === 256 ? 0 : size, entry); // width
    header.writeUInt8(size === 256 ? 0 : size, entry + 1); // height
    header.writeUInt8(0, entry + 2); // palette colours
    header.writeUInt8(0, entry + 3); // reserved
    header.writeUInt16LE(1, entry + 4); // colour planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  return Buffer.concat([header, ...images.map(({ png }) => png)]);
};
