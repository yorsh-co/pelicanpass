import { fileURLToPath } from 'node:url';

import cookieParser from 'cookie-parser';
import express from 'express';
import expressLayouts from 'express-ejs-layouts';

import { ADMIN_NAV } from '../../constants/admin-nav.ts';
import { COPY_DEFAULTS } from '../../constants/copy-defaults.ts';
import { CREDIT } from '../../constants/credit.ts';
import { localeMiddleware } from '../../i18n/server.ts';

import { SAMPLE, adminMessages, sampleLocale } from './fixtures.ts';

import type { Express, RequestHandler, Response } from 'express';

import type { AdminNavItem } from '../../constants/admin-nav.ts';
import type { MessagesOf } from '../../i18n/generated/registry.ts';

import type { Context, ViewCase } from './fixtures.ts';

const VIEWS = fileURLToPath(new URL('.', import.meta.url));

/** Inputs to {@link createViewApp}. */
export interface ViewAppOptions {
  /** Cases served at `/<name>`. */
  cases: readonly ViewCase[];

  /** Nonce for the response being rendered, read once per request. */
  nonce: () => string;

  /** Release id written to the layouts and the status page. */
  releaseId: string;

  /** Label of an administrator nav entry; defaults to its key. */
  navLabel?: (item: AdminNavItem, shell: MessagesOf['admin-shell']) => string;

  /** Middleware mounted after the response locals are set and before routing. */
  use?: readonly RequestHandler[];
}

/**
 * Mounts the real Express view engine and `express-ejs-layouts` with the
 * chrome the application sets around a page, and serves each case at
 * `/<name>`.
 *
 * Shared by the view snapshot suite and the demo build so both render the
 * markup the browser receives.
 *
 * @param options - See {@link ViewAppOptions}.
 * @returns An app that answers a case's HTML, or 500 with the error's stack.
 */
export const createViewApp = ({
  cases,
  nonce,
  releaseId,
  navLabel = (item) => item.key,
  use = [],
}: ViewAppOptions): Express => {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(expressLayouts);
  app.set('layout', 'layouts/main');

  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.locals.cspNonce = nonce();
    res.locals.releaseId = releaseId;
    res.locals.copyDefaults = COPY_DEFAULTS;
    res.locals.credit = CREDIT;
    next();
  });
  app.use(localeMiddleware);

  for (const middleware of use) app.use(middleware);

  app.get('/:name', (req, res, next) => {
    const found = cases.find((entry) => entry.name === req.params.name);

    if (!found) {
      next(new Error(`No case named ${req.params.name}`));
      return;
    }

    const { locale } = res.locals;
    const ctx: Context = {
      locale,
      release: releaseId,
      chrome: res.locals.chrome,
      m: adminMessages(locale),
    };

    if (found.admin) {
      const shell = ctx.m.shell;

      res.locals.shell = shell;
      res.locals.adminUsername = SAMPLE[sampleLocale(locale)].operator;
      res.locals.adminScopes = ADMIN_NAV.map((item) => item.scope);
      res.locals.adminNav = ADMIN_NAV.map((item) => ({
        ...item,
        label: navLabel(item, shell),
      }));
    }

    res.render(
      found.view,
      found.locals(ctx),
      (err: Error | null, html?: string) => {
        if (err) {
          next(err);
          return;
        }

        (res as Response).type('html').send(html);
      },
    );
  });

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(500)
        .type('text')
        .send(err.stack ?? err.message);
    },
  );

  return app;
};
