import { ApiError } from '../api/api.error.ts';

import type { ApiErrorCode } from '../api/api.error.ts';

/**
 * Reports errors that happen in the browser.
 *
 * Nothing in this application knew a frontend was broken until somebody walked
 * over and said so — no `window.onerror`, no `unhandledrejection`, nothing. On
 * seven hundred phones over venue wifi that is a long walk.
 *
 * Everything here is best-effort and silent. A telemetry reporter that throws,
 * blocks a render or floods a door is worse than one that misses a report, so
 * every path below fails closed and says nothing.
 */

const ENDPOINT = '/api/v1/client-errors';

/**
 * Reports allowed per page load.
 *
 * One throw inside a `requestAnimationFrame` loop is sixty a second. The cap is
 * the client's own courtesy — `clientErrorIpLimiter` is the actual control —
 * but it is what keeps an ordinary bug from becoming a denial of service
 * against the door it is trying to report on.
 */
const MAX_REPORTS = 5;

/**
 * Codes the interface already handles, which must never be reported.
 *
 * A mistyped ticket code is a `VALIDATION_ERROR` and has a screen of its own; a
 * spent budget is `RATE_LIMITED` and has copy explaining the wait. Reporting
 * these would bury the real defects under the application working correctly —
 * and at the door, `VALIDATION_ERROR` is the single most common outcome there
 * is.
 */
const EXPECTED: ReadonlySet<string> = new Set<ApiErrorCode>([
  'VALIDATION_ERROR',
  'CAPTCHA_REQUIRED',
  'RATE_LIMITED',
  'EDGE_CHALLENGE',
  'EDGE_UNREACHABLE',
  'EDGE_TIMEOUT',
  'SERVICE_UNAVAILABLE',
  'CHECKIN_NOT_OPEN',
  'SURVEY_CLOSED',
  'SURVEY_ANSWERED',
  'SURVEY_STALE',
  'EVENT_CLOSED',
  'UNAUTHORIZED',
  'NOT_MARKED_PRESENT',
]);

let sent = 0;

/** Signatures already reported on this page load. */
const seen = new Set<string>();

/** The release the bundle was built from, read off the page. */
const releaseId = (): string =>
  document.documentElement.dataset.release ?? 'dev';

/** A cheap, stable signature for deduplication. Not a security primitive. */
const signatureOf = (message: string, stack: string): string => {
  const frame = stack.split('\n')[1]?.trim() ?? '';

  return `${message}|${frame}`;
};

interface Report {
  message: string;
  url: string;
  name?: string;
  stack?: string;
  line?: number;
  col?: number;
  releaseId: string;
}

/**
 * Sends one report, preferring `keepalive` so it survives the navigation that
 * often follows the error that caused it.
 *
 * The `sendBeacon` fallback sends a **typed `Blob`**, not a string. A string
 * beacon is delivered as `text/plain;charset=UTF-8`, and the API answers 415 to
 * anything that is not JSON when a `Content-Type` is present — so the beacon
 * path would fail exactly on the way out of the page, which is the one place it
 * is the only option left.
 */
const send = (report: Report): void => {
  const body = JSON.stringify(report);

  try {
    if (typeof navigator.sendBeacon === 'function' && document.hidden) {
      navigator.sendBeacon(
        ENDPOINT,
        new Blob([body], { type: 'application/json' }),
      );

      return;
    }

    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'include',
    }).catch(() => undefined);
  } catch {
    // A reporter that throws while reporting is a loop. Nothing to do.
  }
};

/**
 * Reports one error, if it is worth reporting and there is budget left.
 *
 * @param error - The thrown value, whatever it turned out to be.
 * @param extra - Line and column, when an error event carried them.
 */
export const reportError = (
  error: unknown,
  extra: { line?: number; col?: number } = {},
): void => {
  try {
    // Expected outcomes are not defects. `ApiError` carries the codes the
    // interface already has screens for.
    if (error instanceof ApiError && EXPECTED.has(error.code)) return;

    if (sent >= MAX_REPORTS) return;

    // A rejection can carry anything at all. Only the two cases that stringify
    // to something a human can read are kept; an object would arrive as
    // "[object Object]", which is a row in the table that answers nothing.
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string' || typeof error === 'number'
          ? String(error)
          : `non-Error rejection (${typeof error})`;

    const stack = error instanceof Error ? (error.stack ?? '') : '';
    const signature = signatureOf(message, stack);

    if (seen.has(signature)) return;

    seen.add(signature);
    sent += 1;

    send({
      message,
      // Sent whole; the server masks it. `?t=` is a live credential and
      // `maskUrlSecrets` is the one place that decision is made.
      url: window.location.href,
      name: error instanceof Error ? error.name : 'unknown',
      stack: stack.slice(0, 4_000),
      ...extra,
      releaseId: releaseId(),
    });
  } catch {
    // Reporting must never become the failure it is reporting on.
  }
};

/**
 * Installs the global handlers.
 *
 * Called once, from the bundle both layouts load. Registered as listeners
 * rather than by assigning `window.onerror`, so nothing else on the page can
 * displace them by assigning it later.
 */
export const installErrorReporting = (): void => {
  window.addEventListener('error', (event) => {
    // A failed image or stylesheet fires this too, with no `error` object.
    // Those are asset problems and belong to the network panel, not here.
    if (!event.error) return;

    reportError(event.error, { line: event.lineno, col: event.colno });
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason);
  });
};
