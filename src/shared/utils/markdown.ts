import { Marked } from 'marked';

import type { Tokens } from 'marked';

const SAFE_SCHEMES: readonly string[] = ['http', 'https', 'mailto'];

/** Characters a browser ignores inside a URL's scheme, plus whitespace. */
// eslint-disable-next-line no-control-regex
const IGNORED_IN_URL = /[\u0000- \u007f-\u009f]/g;

/** Everything up to the first `/`, `?` or `#`: where a scheme would sit. */
const FIRST_SEGMENT = /^[^/?#]*/;

/**
 * Tells whether a link or image target is safe to emit.
 *
 * A target is relative when its first segment holds neither `:` nor `&`, and
 * is allowed. Otherwise it must start with `http:`, `https:` or `mailto:`.
 * Whitespace and control characters are dropped before the check because
 * browsers ignore them inside a scheme. A `&` in that segment is refused
 * because an entity there (`&#106;avascript:`, `javascript&colon;`) reaches
 * the browser decoded.
 *
 * @param url - The target as `marked` hands it to a renderer.
 */
export const isSafeUrl = (url: string): boolean => {
  const segment =
    FIRST_SEGMENT.exec(url.replace(IGNORED_IN_URL, ''))?.[0] ?? '';

  if (!/[:&]/.test(segment)) return true;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(segment)?.[1];

  return scheme !== undefined && SAFE_SCHEMES.includes(scheme.toLowerCase());
};

/**
 * Escapes the characters that matter in HTML text and attribute values.
 *
 * @param text - Plain text.
 */
const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * A `marked` instance for content that is emitted unescaped into a page.
 *
 * Raw HTML, block or inline, is escaped, so it shows as text. A link or image
 * is rendered only when its target is safe (see {@link isSafeUrl}); otherwise
 * a link keeps its text and an image keeps its alt text.
 */
export const safeMarked = new Marked({
  renderer: {
    html: ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text),
    link(token: Tokens.Link) {
      return isSafeUrl(token.href)
        ? false
        : this.parser.parseInline(token.tokens);
    },
    image: (token: Tokens.Image) =>
      isSafeUrl(token.href) ? false : escapeHtml(token.text),
  },
});

/**
 * Renders Markdown to HTML that is safe to output unescaped.
 *
 * @param source - Markdown text.
 * @returns The rendered HTML.
 */
export const renderMarkdown = (source: string): string =>
  safeMarked.parse(source, { async: false });
