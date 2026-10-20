/** A child of an element: nodes, text, or nothing. */
export type Child = Node | string | number | null | false | undefined;

/** Options for {@link el}. */
export interface ElOptions {
  class?: string;
  attrs?: Record<string, string>;
  on?: {
    [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void;
  };
}

/**
 * Creates an element. String children become text nodes, so untrusted text
 * can never be parsed as markup.
 *
 * @param tag - The tag name.
 * @param options - Class, attributes and listeners.
 * @param children - Content.
 */
export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);

  if (options.class !== undefined) node.className = options.class;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  for (const [type, listener] of Object.entries(options.on ?? {})) {
    node.addEventListener(type, listener as EventListener);
  }
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    node.append(typeof child === 'number' ? String(child) : child);
  }

  return node;
};

/** Escapes text for the HTML of a chart tooltip. */
export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
