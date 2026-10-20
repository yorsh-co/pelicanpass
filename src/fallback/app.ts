import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import helmet from 'helmet';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';

import type { Express, Response } from 'express';

import { COPY_DEFAULTS } from '../constants/copy-defaults.ts';
import { toAudienceRole } from '../constants/audience.ts';
import { getMessages } from '../i18n/catalogs.ts';
import { BASE_LOCALE } from '../i18n/locales.ts';
import { permissionsPolicy } from '../middleware/permissions-policy.middleware.ts';
import { REDACT_PATHS } from '../shared/logger/redact-paths.ts';
import { NOTICES } from '../web/content/notices.ts';
import { closingView, landingView } from '../web/landing/landing-view.ts';

import type { AppErrorCode } from '../types/appErrorCode.ts';
import type { FallbackConfig } from './config.ts';

/**
 * How long a client is told to wait before retrying a refused API call or
 * form post. Matches the floor the landing page reloads on.
 */
const RETRY_AFTER_SECONDS = 30;

/**
 * Builds the standalone landing fallback.
 *
 * Serves the pre-event curtain, the privacy notice and the terms while the
 * live stack is being restarted, from a machine with no database, no cache and
 * none of the production secrets. It imports nothing that reads `config/env.ts`
 * for that reason.
 *
 * Every page path answers with the curtain **in place** — no redirect — so
 * `?audience=` is kept, and with `no-store` so neither Cloudflare nor a phone
 * keeps the curtain after the live app is back. The page strips a `?t=` or
 * `?k=` token from the address bar on load, so one does not survive the wait.
 * Past the window the curtain shows the reopening notice and the page reloads
 * itself; see `pages/landing/index.ts`.
 *
 * Past `closesAt` every page path answers with the closing page instead, and
 * the API with the live app's `410 EVENT_CLOSED`. That is what lets this
 * process keep the hostname answering after the production host is torn down.
 *
 * Locale is fixed to the base locale: production offers no other.
 *
 * @param config - See {@link FallbackConfig}.
 */
export const createFallbackApp = (config: FallbackConfig): Express => {
  const app = express();

  const isClosed = (): boolean =>
    config.closesAt !== null && Date.now() >= config.closesAt;

  const logger = pino({
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });

  app.set('view engine', 'ejs');
  app.set('views', fileURLToPath(new URL('../web/views', import.meta.url)));

  app.use(expressLayouts);
  app.set('layout', 'layouts/plain');

  // cloudflared connects straight to this process, so it is the one proxy hop.
  app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger,
      // The path alone: the query string carries check-in entry tokens.
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          path: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      // The 503 below is this server doing its job, not failing at it: without
      // these every poll from a page left open would log as an error with a
      // synthetic stack trace.
      customLogLevel: (_req, res, err) =>
        res.statusCode === 503
          ? 'info'
          : err || res.statusCode >= 500
            ? 'error'
            : 'info',
      customErrorObject: (_req, res, _err, val: Record<string, unknown>) =>
        res.statusCode === 503 ? { ...val, err: undefined } : val,
    }),
  );

  const chrome = getMessages(BASE_LOCALE, 'chrome');

  app.use((_req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    res.locals.locale = BASE_LOCALE;
    res.locals.chrome = chrome;
    res.locals.copyDefaults = COPY_DEFAULTS;
    res.locals.localeLinks = [];

    next();
  });

  // The live app's policy without the Turnstile origins: nothing served here
  // renders a challenge.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          scriptSrc: [
            "'self'",
            (_req, res) =>
              `'nonce-${String((res as Response).locals.cspNonce)}'`,
          ],
          styleSrc: [
            "'self'",
            (_req, res) =>
              `'nonce-${String((res as Response).locals.cspNonce)}'`,
          ],
          fontSrc: ["'self'"],
        },
      },
    }),
  );

  app.use(permissionsPolicy);

  app.use(
    express.static(fileURLToPath(new URL('../web/public', import.meta.url))),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Pages are rendered per request and must never outlive the outage.
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/privacy', (_req, res) => {
    res.render('pages/privacy', {
      title: chrome.titlePrivacy({ appTitle: config.appTitle }),
      notice: NOTICES[BASE_LOCALE].privacy,
    });
  });

  app.get('/terms', (_req, res) => {
    res.render('pages/terms', {
      title: chrome.titleTerms({ appTitle: config.appTitle }),
      notice: NOTICES[BASE_LOCALE].terms,
    });
  });

  // A page that is still open against the live app — the pass, the scanner —
  // polls the API; it gets an outage in the envelope it already parses rather
  // than an HTML curtain it would choke on.
  app.use((req, res, next) => {
    const isPage =
      (req.method === 'GET' || req.method === 'HEAD') &&
      !req.path.startsWith('/api/');

    if (isPage) {
      next();
      return;
    }

    // The live app's refusal, so a pass still open reloads onto the closing
    // page rather than retrying an outage that will never end.
    if (isClosed()) {
      const code: AppErrorCode = 'EVENT_CLOSED';

      res.status(410).json({
        success: false,
        error: 'The event has closed',
        code,
      });
      return;
    }

    const code: AppErrorCode = 'INTERNAL_ERROR';

    res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
    res.status(503).json({
      success: false,
      error: 'Service temporarily unavailable',
      code,
    });
  });

  app.use((req, res) => {
    if (isClosed()) {
      res.render(
        'pages/closing',
        closingView({ locale: BASE_LOCALE, appTitle: config.appTitle }),
      );
      return;
    }

    const audience = toAudienceRole(req.query.audience) ?? 'participant';

    res.render(
      'pages/landing',
      landingView({
        opensAt: config.eventStartAt - config.opensBefore[audience],
        now: Date.now(),
        audience,
        locale: BASE_LOCALE,
        timezone: config.timezone,
        appTitle: config.appTitle,
        fallback: true,
      }),
    );
  });

  return app;
};
