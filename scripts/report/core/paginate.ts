/** Vertical extent of one block, measured in the same coordinate space. */
export interface BlockExtent {
  top: number;
  bottom: number;
  /** Whether the block is an h1-h3 heading, which opens a new page. */
  heading: boolean;
}

/**
 * Packs consecutive blocks into pages of at most `capacity` height.
 *
 * A page starts at every heading that finds the current page non-empty, and
 * a heading always stays with the block that follows it. A block taller than
 * `capacity` gets a page of its own.
 *
 * @param blocks - Measured blocks, in document order.
 * @param capacity - Usable height of a page.
 * @returns The block indexes of each page.
 */
export const paginate = (
  blocks: readonly BlockExtent[],
  capacity: number,
): number[][] => {
  const pages: number[][] = [];
  let current: number[] = [];

  blocks.forEach((block, index) => {
    const first = blocks[current[0] ?? -1];
    const hasBody = current.some((i) => blocks[i]?.heading === false);

    if (
      first !== undefined &&
      (block.heading || (hasBody && block.bottom - first.top > capacity))
    ) {
      pages.push(current);
      current = [];
    }
    current.push(index);
  });
  if (current.length > 0) pages.push(current);

  return pages;
};
