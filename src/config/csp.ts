import type { IncomingMessage, ServerResponse } from 'node:http';

/** Produces the `'nonce-…'` source for the response being served. */
export type NonceSource = (req: IncomingMessage, res: ServerResponse) => string;

/**
 * Builds the Content-Security-Policy directives layered over helmet's defaults.
 *
 * @param nonceSource - Source added to `script-src` and `style-src`. Passed as
 *   a callback so each response carries its own nonce.
 * @returns The directives, in the shape helmet's `contentSecurityPolicy`
 *   option accepts.
 */
export const cspDirectives = (
  nonceSource: NonceSource,
): Record<string, (string | NonceSource)[]> => ({
  scriptSrc: ["'self'", 'https://challenges.cloudflare.com', nonceSource],
  // Narrowed from helmet's `'self' https:` default, which allows any
  // HTTPS origin. Styles and fonts are all first-party since the fonts
  // were vendored, so no external origin is permitted for either. Views
  // carry no inline `style` attribute; the one `<style>` block, in the
  // `<noscript>` of the main layout, takes the response nonce.
  styleSrc: ["'self'", nonceSource],
  // Fonts are vendored under /assets/fonts. No CSS declares a `data:`
  // font, so that source is gone with the Google origins.
  fontSrc: ["'self'"],
  frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
});
