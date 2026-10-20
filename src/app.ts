import { fileURLToPath } from 'url';

import express from 'express';
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import expressLayouts from 'express-ejs-layouts';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import crypto from 'crypto';

import { env } from './config/env.ts';
import { COPY_DEFAULTS } from './constants/copy-defaults.ts';
import { BASE_LOCALE } from './i18n/locales.ts';
import { getMessages } from './i18n/server.ts';
import apiRoutes from './api/index.ts';
import webRoutes from './web/routes/web.routes.ts';
import {
  AppError,
  DependencyUnavailableError,
} from './shared/errors/app-error.ts';
import { applyRateLimitHeader } from './shared/errors/apply-rate-limiter-header.ts';
import { requireAccessAssertion } from './middleware/access-jwt.middleware.ts';
import { httpLogger } from './middleware/http-logger.middleware.ts';
import { httpCounters } from './middleware/telemetry.middleware.ts';
import { loadShed } from './middleware/load-shed.middleware.ts';
import { permissionsPolicy } from './middleware/permissions-policy.middleware.ts';
import { readyzRateLimit } from './middleware/rate.middleware.ts';
import { maskUrlSecrets } from './shared/utils/mask.ts';
import { actorOf } from './shared/telemetry/actor.ts';
import { probeDependencies } from './shared/telemetry/probes.ts';
import { recordEvent } from './shared/telemetry/record.ts';
import { renderErrorPage } from './web/errors/render-error-page.ts';

const app = express();

const isDevelopment = env.nodeEnv !== 'production';

app.set('view engine', 'ejs');
app.set('views', fileURLToPath(new URL('./web/views', import.meta.url)));

app.use(expressLayouts);
app.set('layout', 'layouts/main');

app.set('trust proxy', 1); // for use with Caddy and cloudflared

app.use(httpLogger);
app.use(httpCounters);

app.use((_req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');

  // Set here rather than passed by each route, for the same reason the nonce is:
  // every layout renders it onto `<html data-release>`, and a screen added later
  // must inherit it without anybody remembering to. The client error reporter
  // reads it off the document, which is what makes a browser stack trace
  // attributable to a bundle.
  res.locals.releaseId = env.releaseId;

  // A default for responses the web router never reaches — a static-file
  // error, say — which still render a layout. `localeMiddleware` resolves the
  // real value for every web route.
  res.locals.locale = BASE_LOCALE;
  res.locals.chrome = getMessages(BASE_LOCALE, 'chrome');
  res.locals.copyDefaults = COPY_DEFAULTS;
  res.locals.localeLinks = [];

  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        scriptSrc: [
          "'self'",
          'https://challenges.cloudflare.com',
          // helmet types directive callbacks against Node's ServerResponse,
          // which carries no `locals`; the downcast holds because helmet only
          // ever runs mounted on an Express app.
          (_req, res) => `'nonce-${String((res as Response).locals.cspNonce)}'`,
        ],
        // Narrowed from helmet's `'self' https:` default, which allows any
        // HTTPS origin. Styles and fonts are all first-party since the fonts
        // were vendored, so no external origin is permitted for either. Views
        // carry no inline `style` attribute; the one `<style>` block, in the
        // `<noscript>` of the main layout, takes the response nonce.
        styleSrc: [
          "'self'",
          (_req, res) => `'nonce-${String((res as Response).locals.cspNonce)}'`,
        ],
        // Fonts are vendored under /assets/fonts. No CSS declares a `data:`
        // font, so that source is gone with the Google origins.
        fontSrc: ["'self'"],
        frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
      },
    },
  }),
);

app.use(permissionsPolicy);

app.use(cookieParser());

/**
 * Kills client caching outside production.
 *
 * The default `express.static` headers (`public, max-age=0` plus an ETag) are a
 * revalidate-every-time contract on paper, but iOS Safari reuses cached
 * stylesheets and module scripts without revalidating, so a watch-mode rebuild
 * is invisible on a phone until its website data is cleared. `no-store` removes
 * the entry entirely rather than asking the browser to check it.
 *
 * Registered ahead of `express.static` and the routers so it covers rendered
 * pages too; the validators are disabled below so `send` cannot answer 304 from
 * a stale entry that predates this header.
 */
if (isDevelopment) {
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
}

/**
 * How long a static file may be reused without asking.
 *
 * Tiered by what a stale copy costs, because the three groups differ:
 *
 * - `/js/chunks/*` is content-hashed by `scripts/build-client.ts`, so a rebuild
 *   produces a different filename and a stale copy cannot happen. A year and
 *   `immutable` — the latter is what stops a reload revalidating anyway.
 * - Fonts and images are not hashed, but they are cosmetic and settled before
 *   the doors open. A week. This is the tier that matters at the door: without
 *   it the backdrop is revalidated on every navigation an attendee makes
 *   through the landing page, check-in, the success card and the pass.
 * - Everything else — the stylesheets and the theme entry point — is unhashed
 *   AND carries layout and behaviour, so it keeps `express.static`'s default
 *   revalidate-every-time. One conditional request against a stale sheet in
 *   the middle of the event is the right trade.
 *
 * The escape hatch for that week is to rename the file and its one reference.
 * Deliberate, and about the right amount of friction for a change that has to
 * reach a phone which already loaded the old one.
 */
const CACHE_A_YEAR_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_A_WEEK = 'public, max-age=604800';

const staticCacheControl = (path: string): string | null => {
  if (path.includes('/js/chunks/')) return CACHE_A_YEAR_IMMUTABLE;

  if (/\/assets\/(fonts|images)\//.test(path)) return CACHE_A_WEEK;

  return null;
};

app.use(
  express.static(
    fileURLToPath(new URL('./web/public', import.meta.url)),
    // `cacheControl: false` keeps `send` from overwriting the header above.
    isDevelopment
      ? { cacheControl: false, etag: false, lastModified: false }
      : {
          setHeaders: (res, path) => {
            const value = staticCacheControl(path);

            if (value) res.setHeader('Cache-Control', value);
          },
        },
  ),
);

/**
 * Liveness probe for the container HEALTHCHECK and Caddy's upstream check.
 *
 * Registered ahead of the router mounts so a probe running every 30s is not
 * charged against `ipLimiter` or `webLimiter`.
 */
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

/** Answers 404 unless the tailnet listener vouched for the request. */
const requireTailnet: RequestHandler = (req, res, next) => {
  if (req.get('X-Admin-Gate') === 'tailnet') {
    next();

    return;
  }

  res.sendStatus(404);
};

/**
 * Readiness probe: whether the dependencies a request actually needs are there.
 *
 * Deliberately **not** wired to the container `HEALTHCHECK` or Caddy's
 * `health_uri`, and `Dockerfile` says why — a readiness check on a restart
 * policy turns a Redis blip into a container restart in the middle of the
 * event, which is worse than the blip. Nothing restarts on this. Somebody reads
 * it, or the alert rules do.
 *
 * With Redis gone the container stays green while every attendee-facing
 * surface answers 503; this is the endpoint that says so.
 *
 * Not public — it discloses dependency state, so the Caddyfile answers 403 for
 * it on the tunnel vhost and serves it only over the tailnet. The route
 * enforces that itself too, because Express also routes `/readyz/` and other
 * spellings here that an exact proxy matcher can miss. Registered above the
 * routers for the same reason `/healthz` is: a probe on a timer must not be
 * charged against `ipLimiter` or `webLimiter`.
 */
app.get('/readyz', requireTailnet, readyzRateLimit, (_req, res) => {
  // Explicit, because the only other `no-store` on this response is the
  // development-only middleware above — in production this answered with an
  // ETag and no cache directive at all. The metrics dashboard falls back to
  // this endpoint precisely when the snapshot cannot answer, so a revalidated
  // or heuristically cached reply would report a dependency as healthy while
  // an operator was staring at the outage.
  res.setHeader('Cache-Control', 'no-store');

  void probeDependencies().then(({ redis, postgres }) => {
    const ready = redis.ok && postgres.ok;

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      release: env.releaseId,
      dependencies: {
        redis: {
          ok: redis.ok,
          durationMs: redis.durationMs,
          ...(redis.error ? { error: redis.error } : {}),
        },
        postgres: {
          ok: postgres.ok,
          durationMs: postgres.durationMs,
          ...(postgres.error ? { error: postgres.error } : {}),
        },
      },
    });
  });
});

// After the probes and static files, so neither is ever shed; before
// everything that does real work, so a shed request costs next to nothing.
app.use(loadShed);

// One prefix mount rather than one guard per router, and that is the point. The
// administrator surface is spread across six registrations — the `/admin` API
// router, `/admin/auth`, `/admin/metrics` and `/admin/whatsapp/runs/current`
// (each mounted apart in src/api/index.ts for its own limiter), the adminPage()
// chain, and `GET /admin/login`, which goes through neither. A gate that has to
// be remembered at each of those will eventually be forgotten at one; a prefix
// covers every route added later without anybody remembering to.
//
// Above both routers, so it also sits above the 404 below: an unknown path under
// /admin now answers 403 rather than 404, which is the better answer. /healthz
// and /readyz are registered further up and are unaffected.
app.use(['/admin', '/api/v1/admin'], requireAccessAssertion);

app.use('/api/v1', apiRoutes);

app.use('/', webRoutes);

// Also catches unmatched `/api/**` paths — the API router has an error handler
// but no catch-all of its own. renderErrorPage answers those in JSON.
app.use((req, res) => {
  renderErrorPage(req, res, 404);
});

/**
 * Central error handler for the EJS-rendered web routes, mirroring the API's
 * errorHandler but rendering pages/error through layouts/plain rather than
 * responding in JSON.
 *
 * The unused-looking `next` parameter is required.
 */
const webErrorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const message = isAppError ? err.message : 'Server error';

  const degraded = err instanceof DependencyUnavailableError;

  // Read by `httpLogger` for the response line.
  if (degraded) res.locals.degraded = true;

  if ((isAppError && statusCode < 500) || degraded) {
    req.log.warn(
      { path: maskUrlSecrets(req.originalUrl), statusCode, message },
      'Web request error',
    );
  } else {
    req.log.error(
      {
        path: maskUrlSecrets(req.originalUrl),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'Web unexpected error',
    );
  }

  // A second sink, not a second log line — recordEvent does not log. This is
  // the whole web surface; until now only the API router's handler recorded,
  // so a 500 rendering a page left nothing queryable behind.
  //
  // The catch-all 404 above is deliberately not recorded: it reaches
  // renderErrorPage without anything having been thrown, and storing it would
  // fill the table with scanner traffic. It is counted as `http.4xx`, which is
  // the right altitude for it.
  recordEvent({
    severity: (isAppError && statusCode < 500) || degraded ? 'warn' : 'error',
    kind: 'http_error',
    code: isAppError ? err.code : 'INTERNAL_ERROR',
    // The thrown message, not the `message` above. That one is sanitised for
    // the client — an unexpected failure renders as 'Server error' so an
    // internal string cannot reach the page — and storing it would make every
    // web 500 a row that says nothing about what broke. This record is read on
    // the tailnet-only admin surface and is purged with the attendee data, and
    // the API handler already stores the thrown message, so this is what makes
    // the two surfaces answer the same question the same way.
    message: err instanceof Error ? err.message : String(err),
    route: maskUrlSecrets(req.originalUrl),
    statusCode,
    requestId: typeof req.id === 'string' ? req.id : undefined,
    stack: err instanceof Error ? err.stack : undefined,
    ...actorOf(req),
  });

  if (isAppError) applyRateLimitHeader(err, res);

  renderErrorPage(req, res, statusCode, err);
};

app.use(webErrorHandler);

export default app;
