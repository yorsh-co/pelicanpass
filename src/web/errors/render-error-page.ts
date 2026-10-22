import type { Request, Response } from 'express';

import { env } from '../../config/env.ts';
import { BASE_LOCALE } from '../../i18n/locales.ts';
import { getMessages } from '../../i18n/server.ts';
import { AppError } from '../../shared/errors/app-error.ts';

import type { MessagesOf } from '../../i18n/generated/registry.ts';
import type { Locale } from '../../i18n/locales.ts';
import type { AppErrorCode } from '../../types/appErrorCode.ts';

type ErrorMessages = MessagesOf['errors'];

/** A call-to-action rendered below the message, when retrying makes sense. */
interface ErrorPageAction {
  href: string;
  label: string;
}

/** Client-facing copy for one error status. */
interface ErrorPageCopy {
  /** Large glyph or short phrase at the top of the card. */
  heading: string;
  /** One line naming what happened. */
  subtitle: string;
  /**
   * Sentence or two explaining it, in plain language. Named `message` rather
   * than `body` throughout: express-ejs-layouts hands the rendered page to the
   * layout as a local called `body`, then copies the render options over it
   * (`lib/express-layouts.js`), so a local of that name silently replaces the
   * entire page with this string.
   */
  message: string;
  /** Omitted where retrying is the problem rather than the fix. */
  action?: ErrorPageAction;
}

/**
 * Where the home button of an error page points: `/admin` for a request under
 * it, `/` for everything else. Read from `originalUrl`, minus the query string,
 * so the answer does not depend on where a router is mounted.
 *
 * @param req - Request that failed.
 */
const homeHrefFor = (req: Request): string => {
  const [path = ''] = req.originalUrl.split('?', 1);

  return path === '/admin' || path.startsWith('/admin/') ? '/admin' : '/';
};

/**
 * `/` rather than `/checkin` for attendees: the pass route is guarded by
 * `requireWebAuth('attendee', '/checkin')`, so a visitor without a session is
 * bounced to check-in and one with a session lands on their pass. One link
 * serves both. Under `/admin` the link is `/admin`, where `requireWebAuth`
 * redirects an administrator without a session to `/admin/login`.
 */
const homeAction = (m: ErrorMessages, href: string): ErrorPageAction => ({
  href,
  label: m.homeAction(),
});

/**
 * Per-status copy. Deliberately static: the thrown error's own `message` is
 * never rendered, so an internal string can't reach the page.
 */
const ERROR_COPY: Record<
  number,
  (m: ErrorMessages, homeHref: string) => ErrorPageCopy
> = {
  404: (m, homeHref) => ({
    heading: m.notFoundHeading(),
    subtitle: m.notFoundSubtitle(),
    message: m.notFoundMessage(),
    action: homeAction(m, homeHref),
  }),
  429: (m) => ({
    heading: m.rateLimitedHeading(),
    subtitle: m.rateLimitedSubtitle(),
    // No action: the page exists because the visitor is retrying too fast, so
    // handing them a button to retry with would be working against them.
    message: m.rateLimitedMessage(),
  }),
  500: (m, homeHref) => ({
    heading: m.internalHeading(),
    subtitle: m.internalSubtitle(),
    message: m.internalMessage(),
    action: homeAction(m, homeHref),
  }),
  503: (m) => ({
    heading: m.busyHeading(),
    subtitle: m.busySubtitle(),
    // No action, for the reason 429 has none: the server is shedding load, and
    // a button invites the immediate retry it is asking the visitor to hold.
    message: m.busyMessage(),
  }),
};

/** Used for every status without an entry above — 400, 403, 503, anything. */
const fallbackCopy = (m: ErrorMessages, homeHref: string): ErrorPageCopy => ({
  heading: m.fallbackHeading(),
  subtitle: m.fallbackSubtitle(),
  message: m.fallbackMessage(),
  action: homeAction(m, homeHref),
});

/**
 * The page copy for a status in a locale, with the wait folded into the 429
 * message when it is known. Also used by the demo's 404 fixture.
 *
 * @param statusCode - HTTP status being rendered.
 * @param locale - Locale to render in.
 * @param retryAfterSeconds - Value carried by a {@link RateLimitError}'s
 *   details. Rounded up to minutes beyond sixty seconds.
 * @param homeHref - Target of the home button, where the status has one.
 */
export const copyFor = (
  statusCode: number,
  locale: Locale,
  retryAfterSeconds: number | undefined,
  homeHref: string,
): ErrorPageCopy => {
  const m = getMessages(locale, 'errors');
  const copy = (ERROR_COPY[statusCode] ?? fallbackCopy)(m, homeHref);

  if (statusCode !== 429 || !retryAfterSeconds) return copy;

  const message =
    retryAfterSeconds <= 60
      ? m.rateLimitedMessageWithRetry({
          unit: 'seconds',
          count: retryAfterSeconds,
        })
      : m.rateLimitedMessageWithRetry({
          unit: 'minutes',
          count: Math.ceil(retryAfterSeconds / 60),
        });

  return { ...copy, message };
};

/**
 * What the JSON branch reports when there is no `AppError` to read it from —
 * which is every unmatched `/api/**` path, since the catch-all 404 in `app.ts`
 * is reached without anything having been thrown.
 *
 * Mirrors the defaults on the matching `AppError` subclasses, so a missing
 * route and a thrown `NotFoundError` are indistinguishable to a client. Kept in
 * English, like the rest of the API surface; the page copy above is for the
 * page and never reaches JSON.
 */
const JSON_DEFAULTS: Record<number, { code: AppErrorCode; error: string }> = {
  404: { code: 'NOT_FOUND', error: 'Resource not found' },
  429: { code: 'RATE_LIMITED', error: 'Too many requests' },
  503: { code: 'SERVICE_UNAVAILABLE', error: 'Server busy' },
};

const JSON_FALLBACK = {
  code: 'INTERNAL_ERROR',
  error: 'Internal server error',
} as const;

/**
 * Whether this request wants JSON rather than an HTML page.
 *
 * The path check comes first and is not merely an optimisation: the app-level
 * 404 in `app.ts` sits after the API router, which registers no catch-all of
 * its own, so every unmatched `/api/**` path arrives here. A JSON client that
 * sends no `Accept` header must still get JSON.
 */
const wantsJson = (req: Request): boolean =>
  req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json';

/**
 * Sends a styled error page — or the equivalent JSON — for a failed web request.
 *
 * Shared by the app's catch-all 404 and its web error handler, which is why the
 * copy table and the format negotiation live here rather than at either call
 * site.
 *
 * The page renders through `layouts/plain`, not `layouts/main`: that layout
 * shows a full-viewport boot screen only JavaScript takes down, and hides
 * `<main>` under `<noscript>`. A 500 can be caused by the very asset pipeline
 * those depend on, so the error page must not need JavaScript to be readable.
 *
 * @param req - Request that failed; read for path and `Accept` only.
 * @param res - Response to send on. Headers must not have been sent yet.
 * @param statusCode - HTTP status to respond with.
 * @param err - The thrown value, when there was one. Only its `code` and
 *   `details` are used; its `message` never reaches the client.
 */
export const renderErrorPage = (
  req: Request,
  res: Response,
  statusCode: number,
  err?: unknown,
): void => {
  const isAppError = err instanceof AppError;

  if (wantsJson(req)) {
    const fallback = JSON_DEFAULTS[statusCode] ?? JSON_FALLBACK;

    res.status(statusCode).json({
      success: false,
      error: isAppError ? err.message : fallback.error,
      code: isAppError ? err.code : fallback.code,
      ...(isAppError && err.details ? { details: err.details } : {}),
    });

    return;
  }

  const retryAfterSeconds = isAppError
    ? err.details?.retryAfterSeconds
    : undefined;

  const homeHref = homeHrefFor(req);
  const copy = copyFor(
    statusCode,
    res.locals.locale,
    retryAfterSeconds,
    homeHref,
  );

  // Rendered through the callback rather than left to Express. An EJS failure
  // in the catch-all 404 is not an error-handler failure, so Express would
  // forward it to `webErrorHandler` — which renders this same template and
  // would fail again. Plain text ends it here.
  res.status(statusCode).render(
    'pages/error',
    {
      layout: 'layouts/plain',
      title: getMessages(res.locals.locale, 'errors').title({
        subtitle: copy.subtitle,
        appTitle: env.appTitle,
      }),
      heading: copy.heading,
      subtitle: copy.subtitle,
      message: copy.message,
      action: copy.action,
    },
    (renderErr: Error | null, html: string) => {
      if (renderErr) {
        req.log.error(
          { statusCode, stack: renderErr.stack },
          'Error page failed to render',
        );

        // In the base locale: whatever broke the render may be the locale's
        // own copy, and this is the last thing the visitor will see.
        const plain = copyFor(
          statusCode,
          BASE_LOCALE,
          retryAfterSeconds,
          homeHref,
        );

        res.type('text/plain').send(`${plain.subtitle}\n${plain.message}\n`);

        return;
      }

      res.send(html);
    },
  );
};
