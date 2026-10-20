import { splitCountdown } from '../../constants/countdown.ts';
import { getCopy, getMessages, inlineCatalogs } from '../../i18n/catalogs.ts';

import type { Locale } from '../../i18n/locales.ts';
import type { AttendeeRole } from '../../types/attendee.ts';

/**
 * What `pages/landing` renders from, for both processes that draw it.
 *
 * The live app raises the curtain from `middleware/landing.middleware.ts`; the
 * standalone fallback in `src/fallback/` draws the same page while the live
 * stack is down. Neither may import the environment here — the fallback runs
 * without the secrets `config/env.ts` requires — so every value arrives as an
 * argument.
 */

/**
 * Browser-chrome colour for the landing page.
 *
 * The top edge of `--brand-backdrop`, Harbour, which is the band the status
 * bar sits against. Without it the chrome
 * stays on `--canvas` while the page fills the viewport with the backdrop,
 * leaving a grey band above a blue page for the days this is the only screen
 * anyone sees.
 *
 * A literal because a meta tag cannot read a custom property — the two values
 * it replaces in `layouts/plain.ejs` are literals for the same reason. It
 * shadows `base/variables.css`; a change to the backdrop has to reach here too.
 */
export const LANDING_THEME_COLOR = '#0e4a5a';

const formatters = new Map<
  string,
  { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat }
>();

/**
 * The date and time formatters for a locale and timezone, built once per
 * process.
 *
 * @param locale - The response's locale.
 * @param timezone - The event's IANA timezone.
 */
const formattersFor = (locale: Locale, timezone: string) => {
  const key = `${locale}:${timezone}`;
  let entry = formatters.get(key);

  if (!entry) {
    entry = {
      date: new Intl.DateTimeFormat(locale, {
        timeZone: timezone,
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
      }),
      time: new Intl.DateTimeFormat(locale, {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
      }),
    };
    formatters.set(key, entry);
  }

  return entry;
};

/**
 * Renders the moment check-in opens as a sentence, in the event's timezone.
 *
 * This is the page's actual information — the ticking clock beside it is
 * decoration, and is hidden from assistive tech for that reason. It is also
 * what someone reads when the countdown never starts because a script failed.
 *
 * @param opensAt - Epoch milliseconds the window opens at.
 * @param locale - The response's locale.
 * @param timezone - The event's IANA timezone.
 * @returns Something like `sábado, 13/09, às 18h30`.
 */
const formatOpensAt = (
  opensAt: number,
  locale: Locale,
  timezone: string,
): string => {
  const at = new Date(opensAt);
  const { date, time } = formattersFor(locale, timezone);

  // pt-BR writes a time of day with an `h`, not a colon; the colon belongs to
  // the clock format next to it, which is counting rather than telling time.
  return getMessages(locale, 'landing').opensAt({
    date: date.format(at),
    time: time.format(at).replace(':', 'h'),
  });
};

/** Inputs to {@link landingView}. */
export interface LandingViewOptions {
  /** Epoch milliseconds the audience's check-in window opens at. */
  opensAt: number;

  /** Epoch milliseconds on this server's clock, read once per render. */
  now: number;

  audience: AttendeeRole;

  locale: Locale;

  /** The event's IANA timezone, for the absolute open time. */
  timezone: string;

  appTitle: string;

  /**
   * Whether the standalone fallback is rendering. At zero the fallback cannot
   * send anybody to check in, so it shows the reopening notice and reloads
   * instead of revealing the check-in link.
   */
  fallback: boolean;
}

/**
 * The render locals for `pages/landing`.
 *
 * @param options - See {@link LandingViewOptions}.
 */
export const landingView = ({
  opensAt,
  now,
  audience,
  locale,
  timezone,
  appTitle,
  fallback,
}: LandingViewOptions) => ({
  layout: 'layouts/plain',
  title: appTitle,
  themeColor: LANDING_THEME_COLOR,
  audience,
  opensAtLabel: formatOpensAt(opensAt, locale, timezone),
  // Rendered rather than left to the first tick, so the page is correct
  // before any script runs and stays correct if none ever does.
  countdown: splitCountdown(opensAt - now),
  fallback,
  // Only the fallback outlives the window; the live gate stops rendering at
  // zero. Drawn server-side so a reload after zero, or a page without script,
  // shows the notice rather than a row of zeros.
  reopening: fallback && now >= opensAt,
  // `serverNow` is what lets the browser count against this clock rather
  // than its own — see `pages/landing/index.ts`.
  initialData: { opensAt, serverNow: now, audience, fallback },
  copy: getCopy(locale, ['landing']),
  messages: inlineCatalogs(locale, ['landing']),
});

/** Inputs to {@link closingView}. */
export interface ClosingViewOptions {
  locale: Locale;

  appTitle: string;
}

/**
 * The render locals for `pages/closing`, the page that replaces the site once
 * `EVENT_CLOSES_AT` has passed.
 *
 * Drawn by the live app's `closingGate` and by the standalone fallback, which
 * keeps serving it after the production host is torn down. Static and
 * script-free, so it ships no catalogs to the browser.
 *
 * @param options - See {@link ClosingViewOptions}.
 */
export const closingView = ({ locale, appTitle }: ClosingViewOptions) => ({
  layout: 'layouts/plain',
  title: appTitle,
  themeColor: LANDING_THEME_COLOR,
  copy: getCopy(locale, ['landing']),
});
