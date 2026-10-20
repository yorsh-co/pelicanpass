/**
 * Looks up an element the page is expected to contain.
 *
 * Throws rather than returning null. Every caller dereferences the result
 * immediately, so a missing element is a broken template — a deploy-time
 * failure, not a runtime state worth branching on — and failing here names the
 * selector instead of surfacing a bare TypeError further downstream.
 *
 * Use {@link qsOptional} for elements that genuinely may not be present.
 *
 * @param selector - CSS selector to look up.
 * @returns The element.
 * @throws {Error} If no element matches.
 */
// The type parameter exists so call sites can name the element they expect —
// qs<HTMLInputElement>(…) — which is the same shape lib.dom gives
// document.querySelector. no-unnecessary-type-parameters only sees it used
// once, in the return position, and cannot tell the two cases apart.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export const qs = <T extends Element = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);

  if (!el) {
    throw new Error(`missing required element: ${selector}`);
  }

  return el;
};

/**
 * Looks up an element that may legitimately be absent, without logging.
 *
 * @param selector - CSS selector to look up.
 * @returns The element, or `null`.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export const qsOptional = <T extends Element = HTMLElement>(
  selector: string,
): T | null => document.querySelector<T>(selector);
