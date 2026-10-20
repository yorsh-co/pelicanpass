/**
 * Ambient declarations for Turnstile, which is loaded from Cloudflare by a
 * `<script>` tag rather than imported, so the bundler never sees it and
 * TypeScript has no other way to know it exists.
 *
 * Deliberately narrow: it covers only the members this codebase calls, not the
 * library's full surface. A hand-written subset is cheaper than an `@types`
 * package for code we do not import, and it fails loudly if a new call site
 * reaches for something undeclared.
 *
 * Turnstile is the only library that needs this. Cloudflare does not publish it
 * in a form we could bundle — it has to be served from their origin.
 *
 * See `views/pages/attendee/checkin/checkin.ejs` for the tag.
 */

/** Options accepted by `turnstile.render`. */
interface TurnstileRenderOptions {
  sitekey: string;
  size?: 'normal' | 'flexible' | 'compact';
  appearance?: 'always' | 'execute' | 'interaction-only';
  action?: string;
  callback?: (token: string) => void;
  'error-callback'?: () => void;
  'expired-callback'?: () => void;
  'timeout-callback'?: () => void;
}

/** Cloudflare Turnstile — https://developers.cloudflare.com/turnstile/ */
interface Turnstile {
  /** Renders a widget into `container` and returns its id. */
  render(
    container: string | HTMLElement,
    options: TurnstileRenderOptions,
  ): string;

  /** Current token for a widget, or `undefined` before one is issued. */
  getResponse(widgetId?: string): string | undefined;

  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
  isExpired(widgetId?: string): boolean;
}

declare const turnstile: Turnstile;
