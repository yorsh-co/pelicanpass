import { readEntryTokens } from './entry-token.ts';
import { startCountdown } from './ui/countdown.ts';

/**
 * The pre-event curtain.
 *
 * Everything on the page is already correct when this runs — the server
 * rendered the open time, the first countdown value and the check-in link. This
 * script only makes the clock move and opens the door when it runs out, so a
 * failure here leaves a page that still tells the reader what they came to
 * find out.
 */

/**
 * Widest delay before this device navigates itself to the check-in flow.
 *
 * A page that sends everyone the instant the clock hits zero would put the
 * whole room through the door in the same second. The venue is one NAT egress
 * — the reasoning is written out over `IP_LIMIT_EXEMPT` in `src/api/index.ts` —
 * and `checkinEntryIpLimiter` allows 60 requests a minute against that single
 * address. Several hundred simultaneous arrivals would be refused, at the door,
 * by the app's own front gate.
 *
 * Each device instead waits a random slice of this window, which restores the
 * spread the queue would have had if nobody had been watching a clock. The
 * button beside the countdown appears immediately, so anyone actually looking
 * at the screen never waits for it.
 *
 * Widen it if the head-count grows.
 */
const NAVIGATE_JITTER_MS = 90_000;

/**
 * Shortest wait before the standalone fallback reloads a page whose window
 * has opened.
 *
 * The fallback has no check-in to send anyone to, so every device reloads
 * until the live app answers instead. The same single NAT egress the jitter
 * above protects would otherwise take the whole room's reloads in one burst
 * the moment the live app returns; the floor keeps a device that loads after
 * zero from reloading immediately, and the jitter is added on top.
 */
const RELOAD_FLOOR_MS = 30_000;

/**
 * Shape of the JSON island `views/pages/landing.ejs` writes.
 *
 * `serverNow` is the whole reason the island exists rather than a pair of data
 * attributes: it is only meaningful next to the `Date.now()` read at the same
 * moment, below.
 */
interface LandingData {
  opensAt: number;
  serverNow: number;

  /** Set when the standalone fallback rendered the page. */
  fallback: boolean;
}

/**
 * Reads the island.
 *
 * Returns `null` on anything unexpected rather than throwing. The page is
 * complete without a countdown, and a template that changed shape should cost
 * the reader a ticking clock, not the open time they came for.
 */
const readData = (): LandingData | null => {
  const el = document.getElementById('landing-data');

  if (!el?.textContent) return null;

  try {
    const parsed: unknown = JSON.parse(el.textContent);

    if (typeof parsed !== 'object' || parsed === null) return null;

    const { opensAt, serverNow, fallback } = parsed as Partial<LandingData>;

    if (typeof opensAt !== 'number' || typeof serverNow !== 'number') {
      return null;
    }

    return { opensAt, serverNow, fallback: fallback === true };
  } catch {
    return null;
  }
};

// `document.querySelector` rather than the shared `qs`/`qsOptional`: importing
// them pulls in `layouts/main/dom.ts`, whose module scope resolves the boot
// screen and the logout button eagerly and throws when they are absent. This
// page runs on layouts/plain, which has neither.
const countdownEl = document.querySelector<HTMLElement>(
  '[data-landing="countdown"]',
);
const actionEl = document.querySelector<HTMLAnchorElement>(
  '[data-landing="action"]',
);
const reopeningEl = document.querySelector<HTMLElement>(
  '[data-landing="reopening"]',
);

/**
 * What the standalone fallback does at zero: swaps the countdown for the
 * notice and reloads on a jittered timer until the live app answers.
 *
 * A reload rather than a navigation to `/checkin`, because the fallback has
 * nothing to send anyone to. An entry token does not survive it by design: it
 * was stripped from the address bar on load, so the attendee taps the link
 * again once the live app answers.
 *
 * @param countdown - The countdown container to hide.
 * @param notice - The reopening notice to reveal.
 */
const awaitLiveApp = (countdown: HTMLElement, notice: HTMLElement): void => {
  countdown.hidden = true;
  notice.hidden = false;

  window.setTimeout(
    () => {
      window.location.reload();
    },
    RELOAD_FLOOR_MS + Math.random() * NAVIGATE_JITTER_MS,
  );
};

/**
 * Entry tokens the page was opened with, held in memory only.
 *
 * Removed from the address bar on load, before anything else can fail, so they
 * never reach browser history, synced history or autocomplete. Unlike the
 * address bar, a variable does not survive a reload.
 */
const entry = readEntryTokens(window.location.href);

if (
  entry.cleanPath !== `${location.pathname}${location.search}${location.hash}`
) {
  history.replaceState(history.state, '', entry.cleanPath);
}

const hasTokens = Boolean(entry.tokens.t ?? entry.tokens.k);

/** Set once check-in has been entered, so a tap and the timer never both go. */
let entering = false;

/**
 * Sends this device into the check-in flow, once.
 *
 * With an entry token it posts one to `/checkin`, as `continue.ejs` does, so
 * the attendee lands past the ticket step and the token never appears in a URL.
 * Without one it follows the anchor. Running once matters because each request
 * is charged to `checkinEntryIpLimiter`.
 *
 * @param action - The check-in anchor, whose `audience` the post repeats.
 */
const enterCheckin = (action: HTMLAnchorElement): void => {
  if (entering) return;

  entering = true;

  if (!hasTokens) {
    window.location.href = action.href;

    return;
  }

  const form = document.createElement('form');

  form.method = 'post';
  form.action = '/checkin';

  const fields: Record<string, string | null | undefined> = {
    ...entry.tokens,
    audience: new URL(action.href).searchParams.get('audience'),
  };

  for (const [name, value] of Object.entries(fields)) {
    if (!value) continue;

    const input = document.createElement('input');

    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  }

  document.body.append(form);
  form.submit();
};

const data = readData();

if (countdownEl && actionEl && data) {
  startCountdown({
    root: countdownEl,
    opensAt: data.opensAt,

    // Captured once, against the timestamp the server rendered. Every tick is
    // then measured on the server's clock rather than on this handset's, which
    // may be minutes out.
    offsetMs: data.serverNow - Date.now(),

    onOpen: () => {
      if (data.fallback && reopeningEl) {
        awaitLiveApp(countdownEl, reopeningEl);

        return;
      }

      actionEl.hidden = false;

      if (hasTokens) {
        actionEl.addEventListener('click', (event) => {
          event.preventDefault();
          enterCheckin(actionEl);
        });
      }

      window.setTimeout(() => {
        enterCheckin(actionEl);
      }, Math.random() * NAVIGATE_JITTER_MS);
    },
  });
}
