/**
 * Renders the public demo into a directory of plain files that Cloudflare
 * Pages can serve with no server behind it.
 *
 * The real view engine renders the shared view fixtures (`src/web/views/
 * fixtures.ts`). Once check-in opens the app serves `/` as the pass, so the demo
 * sends `/` to `/checkin`; the pre-event countdown is served at `/landing`
 * instead, counting down from the fixture's own clock. Each response goes
 * through helmet with the production CSP directives; the per-render nonce is
 * stripped and its hash moved into the generated `_headers`, as the closing
 * site does. Assets are copied by following the pages' references.
 *
 * Every page is rendered once per offered locale: pt-BR at the path it has in
 * the app and English under `en/`, each forced through the real locale
 * middleware. The mock script sends a visitor to the tree they chose (see
 * `src/web/client/demo/locale-route.ts`); the footer and admin switchers and
 * the banner link to the matching page of the other tree.
 *
 * Every page gets a banner saying the event and its data are fictional, in the
 * page's language. The banner, its stylesheet and the ticket codes it lists are
 * demo-only copy.
 *
 * Needs the client build (`npm run build`); `npm run build:demo` does both.
 * Reads no `.env`: `./env.ts` supplies a fixed environment, because the fixtures
 * read `config/env.ts`.
 *
 * Usage:
 *   node scripts/demo/build.ts                 writes dist/demo
 *   node scripts/demo/build.ts --out <dir>     writes <dir>
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { mock } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must stay first: it fills the environment `fixtures.ts` validates on load.
import './env.ts';

import * as esbuild from 'esbuild';
import helmet from 'helmet';

import { NAV_LABELS } from '../../src/middleware/admin-chrome.middleware.ts';
import { cspDirectives } from '../../src/config/csp.ts';
import { LOCALE_COOKIE } from '../../src/constants/cookie-names.ts';
import { displayTicketCode } from '../../src/constants/ticket.ts';
import { BASE_LOCALE, PSEUDO_LOCALE } from '../../src/i18n/locales.ts';
import { SUPPORTED } from '../../src/i18n/server.ts';
import { siteManifest } from '../../src/web/content/site-manifest.ts';
import {
  DEMO_LOCALES,
  inTree,
} from '../../src/web/client/demo/locale-route.ts';
import {
  DEMO_TICKET_CODES,
  DEMO_VERIFICATION_CODE,
} from '../../src/web/client/demo/roster.ts';
import { CASES, DEMO_CASES, NOW } from '../../src/web/views/fixtures.ts';
import { createViewApp } from '../../src/web/views/render-app.ts';
import {
  copyReferencedAssets,
  hashPolicy,
  headersFile,
  referencesOf,
  stripNonces,
} from '../static/build.ts';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Response } from 'express';

import type { LocaleLink } from '../../src/i18n/server.ts';
import type { DemoLocale } from '../../src/web/client/demo/locale-route.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'src/web/public');
const DEFAULT_OUT_DIR = path.join(ROOT, 'dist/demo');
const DEMO_CSS = fileURLToPath(new URL('demo.css', import.meta.url));

/** Where the demo's source code and the project's page live. */
export const REPOSITORY_URL = 'https://github.com/yorsh-co/pelicanpass';

/**
 * A rendered fixture and where it is served.
 *
 * Files are `<page>.html`, not `<page>/index.html`: Cloudflare Pages serves
 * `/privacy.html` at `/privacy`, whereas a directory index is reached by a 308
 * to `/privacy/`. Admin pages sit in `admin/` beside `admin.html`.
 */
interface DemoPage {
  /** `ViewCase` name to render. */
  fixture: string;

  /** Path the file is written to, relative to the output directory. */
  file: string;
}

/** The fixture of the not-found page, which answers every unknown path. */
const NOT_FOUND_FIXTURE = 'not-found';

/** Every page the demo ships, including the 404. */
const PAGES: readonly DemoPage[] = [
  { fixture: 'landing', file: 'landing.html' },
  { fixture: 'checkin', file: 'checkin.html' },
  { fixture: 'pass-participant-survey', file: 'pass.html' },
  { fixture: 'pass-volunteer-survey', file: 'pass-volunteer.html' },
  { fixture: 'staff-scan', file: 'staff.html' },
  { fixture: 'raffle-draw', file: 'raffle.html' },
  { fixture: 'privacy', file: 'privacy.html' },
  { fixture: 'terms', file: 'terms.html' },
  { fixture: 'admin-home', file: 'admin.html' },
  { fixture: 'admin-metrics-healthy', file: 'admin/metrics.html' },
  { fixture: 'admin-attendees-demo', file: 'admin/attendees.html' },
  { fixture: 'admin-lookup-search', file: 'admin/lookup.html' },
  { fixture: 'admin-lookup-detail', file: 'admin/lookup-detail.html' },
  { fixture: 'admin-redemptions-index', file: 'admin/redemptions.html' },
  {
    fixture: 'admin-redemptions-detail',
    file: 'admin/redemptions-detail.html',
  },
  { fixture: 'admin-tshirts-search', file: 'admin/tshirts.html' },
  {
    fixture: 'admin-tshirts-detail',
    file: 'admin/tshirts-detail.html',
  },
  { fixture: 'admin-volunteers-index', file: 'admin/volunteers.html' },
  {
    fixture: 'admin-volunteers-detail',
    file: 'admin/volunteers-detail.html',
  },
  { fixture: 'admin-survey', file: 'admin/survey.html' },
  { fixture: 'admin-whatsapp-idle', file: 'admin/whatsapp.html' },
  { fixture: 'admin-pass-demo', file: 'admin/pass.html' },
  { fixture: NOT_FOUND_FIXTURE, file: '404.html' },
];

/**
 * The locales the demo renders: the app's offered locales without the
 * pseudo-locale, which the client script's list must match.
 *
 * @throws {Error} If the two lists differ.
 */
const offeredLocales = (): readonly DemoLocale[] => {
  const offered = SUPPORTED.filter((locale) => locale !== PSEUDO_LOCALE);

  if (offered.join() !== DEMO_LOCALES.join()) {
    throw new Error(
      `The app offers ${offered.join(', ')} but DEMO_LOCALES lists ${DEMO_LOCALES.join(', ')}`,
    );
  }

  return DEMO_LOCALES;
};

/** The file a page is written to in a locale's tree. */
const fileIn = (page: DemoPage, locale: DemoLocale): string =>
  locale === BASE_LOCALE
    ? page.file
    : `${inTree('/', locale).slice(1)}${page.file}`;

/**
 * Where a page is served, as the visitor sees it: `checkin.html` at
 * `/checkin`, `admin.html` at `/admin`.
 */
const servedPath = (page: DemoPage): string =>
  `/${page.file.replace(/\.html$/, '')}`;

/**
 * Link to a page's counterpart in another locale's tree, with `?lang=` so that
 * following it saves the choice without a redirect bounce.
 *
 * The not-found page has no path of its own: it answers whatever unknown path
 * was asked, so its link keeps the current path and lets the mock script move
 * it to the other tree.
 */
const switchHref = (page: DemoPage, locale: DemoLocale): string =>
  page.fixture === NOT_FOUND_FIXTURE
    ? `?lang=${locale}`
    : `${inTree(servedPath(page), locale)}?lang=${locale}`;

/** Release shown in the pages, `v` plus the package version. */
const RELEASE_ID = `v${(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version}`;

/** Cloudflare's public Turnstile test key: its widget always passes, on any host. */
const DEMO_TURNSTILE_SITE_KEY = '1x00000000000000000000AA';

/** Stylesheet the banner uses, written by this build rather than copied. */
const DEMO_CSS_PATH = '/css/demo.css';

/** The mock API's source, and where its bundle is served. */
const MOCK_API_SOURCE = path.join(ROOT, 'src/web/client/demo/mock-api.ts');
const MOCK_API_PATH = '/js/demo/mock-api.js';

/** A ticket of someone already checked in, for the staff lookup. */
const STAFF_EXAMPLE_CODE = 'a2d5f8';

/** Files the build cannot work without; their absence means no client build. */
const REQUIRED_BUILD_OUTPUT = ['css/dist/main.css', 'js/theme/theme.js'];

/** Roots under `src/web/public` that references are copied from. */
const ASSET_ROOT = /^\/(?:assets|css|js)\/|^\/favicon\.ico$/;

/** Inputs to {@link buildDemoSite}. */
export interface BuildDemoSiteOptions {
  /** Directory to write; removed and recreated. */
  outDir: string;

  appTitle: string;
}

/** What {@link buildDemoSite} wrote. */
export interface BuildDemoSiteResult {
  /** Paths relative to `outDir`. */
  files: string[];
  bytes: number;
}

/** The banner's words in one language. */
interface BannerCopy {
  summary: string;
  reset: string;
  details: string;
  /** The other language's name, on the button that links to it. */
  otherLanguage: string;
  /** Builds the instructions from the facts they list. */
  instructions: (facts: BannerFacts) => string;
}

/** What the banner's instructions list; the same in every language. */
interface BannerFacts {
  participants: string;
  volunteers: string;
  staffExample: string;
}

/** The banner's copy by page language. */
const BANNER_COPY: Record<DemoLocale, BannerCopy> = {
  'pt-BR': {
    summary:
      '<strong>Demonstração.</strong> O evento e todos os dados são fictícios.',
    reset: 'Reiniciar demonstração',
    details: 'Detalhes',
    otherLanguage: 'English',
    instructions: ({ participants, volunteers, staffExample }) =>
      `Códigos de ingresso para testar: ${participants} (participante) e ${volunteers} (voluntário). Na verificação, digite <code>${DEMO_VERIFICATION_CODE}</code>; no QR Code, toque em &ldquo;Já fez check-in com um voluntário?&rdquo;. Em <a href="/staff">/staff</a>, digite um código, como <code>${staffExample}</code> ou o seu, em vez de usar a câmera. Em <a href="/admin">/admin</a>, veja o painel administrativo, somente leitura. <a href="${REPOSITORY_URL}" rel="noopener noreferrer">Código-fonte no GitHub</a>.`,
  },
  en: {
    summary: '<strong>Demo.</strong> The event and all data are fictional.',
    reset: 'Reset demo',
    details: 'Details',
    otherLanguage: 'Português',
    instructions: ({ participants, volunteers, staffExample }) =>
      `Ticket codes to try: ${participants} (participant) and ${volunteers} (volunteer). At verification, enter <code>${DEMO_VERIFICATION_CODE}</code>; at the QR code step, tap &ldquo;Already checked in with a volunteer?&rdquo;. At <a href="/staff">/staff</a>, enter a code such as <code>${staffExample}</code> or your own instead of using the camera. At <a href="/admin">/admin</a>, browse the read-only admin panel. <a href="${REPOSITORY_URL}" rel="noopener noreferrer">Source code on GitHub</a>.`,
  },
};

/**
 * Banner markup inserted straight after `<body>`. Demo copy, in the page's own
 * language.
 *
 * The facts are built from the same constants in every language so they cannot
 * drift. The mock script sets `data-demo-banner` on `<html>` before first
 * paint, which collapses the banner to its first line. The reset and collapse
 * buttons are rendered hidden: the mock script shows and binds them, and
 * without that script they would do nothing. The language button is a plain
 * link, so it works either way.
 *
 * @param locale - The page's language.
 * @param otherHref - The same page in the other language, with `?lang=`.
 * @param otherLocale - The other language.
 */
const bannerHtml = (
  locale: DemoLocale,
  otherHref: string,
  otherLocale: DemoLocale,
): string => {
  const list = (codes: readonly string[]): string =>
    codes.map((code) => `<code>${displayTicketCode(code)}</code>`).join(' ');
  const copy = BANNER_COPY[locale];

  return `
<aside class="demo-banner" role="note">
  <p class="demo-banner-lead"><span class="demo-banner-summary">${copy.summary}</span> <button type="button" class="demo-banner-button" data-demo-reset hidden>${copy.reset}</button> <a class="demo-banner-button" href="${otherHref}" hreflang="${otherLocale}" lang="${otherLocale}">${copy.otherLanguage}</a> <button type="button" class="demo-banner-button demo-banner-toggle" data-demo-banner-toggle aria-controls="demo-banner-details" aria-expanded="true" hidden>${copy.details}</button></p>
  <p class="demo-banner-details" id="demo-banner-details">${copy.instructions({
    participants: list(DEMO_TICKET_CODES.participant),
    volunteers: list(DEMO_TICKET_CODES.volunteer),
    staffExample: displayTicketCode(STAFF_EXAMPLE_CODE),
  })}</p>
</aside>
`;
};

/**
 * Where the first `<script` of a document starts, ignoring comments.
 *
 * @returns The offset, or -1 if the document has no script.
 */
const firstScriptAt = (html: string): number => {
  const tokens = /<!--[\s\S]*?-->|<script\b/gi;
  let token = tokens.exec(html);

  while (token !== null) {
    if (!token[0].startsWith('<!--')) return token.index;

    token = tokens.exec(html);
  }

  return -1;
};

/**
 * Adds the demo stylesheet and the mock API to `<head>` and the banner after
 * `<body>`.
 *
 * The mock is a classic script, so the parser runs it on the spot, ahead of the
 * pages' module scripts, which are deferred. It goes before the document's
 * first script, or at the end of `<head>` for a page that has none, so that it
 * patches `fetch` before anything else can call it.
 *
 * @param html - A page with its nonces already stripped.
 * @param banner - The banner markup, from {@link bannerHtml}.
 * @throws {Error} If the page has no `<head>` close or `<body>` open tag.
 */
const addBanner = (html: string, banner: string): string => {
  const headEnd = html.search(/<\/head>/i);
  const body = /<body\b[^>]*>/i.exec(html);

  if (headEnd === -1 || body === null) {
    throw new Error('A page has no <head> or <body> to put the banner in');
  }

  const script = firstScriptAt(html);
  const mockAt = script === -1 || script > headEnd ? headEnd : script;
  const mock = `<script src="${MOCK_API_PATH}"></script>\n`;
  const withMock = `${html.slice(0, mockAt)}${mock}${html.slice(mockAt)}`;

  // The head, and so the mock, precedes the body tag it shifts.
  const at = body.index + body[0].length + mock.length;
  const withBanner = `${withMock.slice(0, at)}${banner}${withMock.slice(at)}`;

  return withBanner.replace(
    /<\/head>/i,
    `  <link rel="stylesheet" href="${DEMO_CSS_PATH}" />\n</head>`,
  );
};

/** A page as rendered in one locale, with its nonces still in it. */
interface RenderedPage {
  page: DemoPage;
  locale: DemoLocale;

  /** Where the file is written: `page.file`, under `en/` for English. */
  file: string;

  html: string;
}

/**
 * Renders every page in every offered locale through the real view engine,
 * and returns them with the CSP header the first response carried.
 *
 * The locale is forced by sending the locale cookie, which the real locale
 * middleware reads, so the views have no demo-only path. The middleware's
 * switcher links point at the fixture's own URL, which is not where the file is
 * served, so they are replaced with links to the matching page of each tree.
 */
const renderPages = async (): Promise<{
  pages: RenderedPage[];
  policy: string;
}> => {
  const locales = offeredLocales();
  const pageByFixture = new Map(PAGES.map((page) => [page.fixture, page]));

  const cases = [...CASES, ...DEMO_CASES].map((entry) =>
    entry.name === 'checkin'
      ? {
          ...entry,
          locals: (ctx: Parameters<typeof entry.locals>[0]) => ({
            ...entry.locals(ctx),
            turnstileSiteKey: DEMO_TURNSTILE_SITE_KEY,
          }),
        }
      : entry,
  );

  const app = createViewApp({
    cases,
    nonce: () => randomBytes(16).toString('base64'),
    releaseId: RELEASE_ID,
    navLabel: (item, shell) => NAV_LABELS[item.key](shell),
    use: [
      (req, res, next) => {
        const page = pageByFixture.get(req.path.slice(1));
        const links = res.locals.localeLinks as LocaleLink[];

        if (page) {
          res.locals.localeLinks = links.map((link) => ({
            ...link,
            href: switchHref(page, link.locale as DemoLocale),
          }));
        }

        next();
      },
      helmet({
        contentSecurityPolicy: {
          directives: cspDirectives(
            (_req, res) =>
              `'nonce-${String((res as Response).locals.cspNonce)}'`,
          ),
        },
      }),
    ],
  });

  const realTz = process.env.TZ;

  process.env.TZ = 'UTC';
  mock.timers.enable({ apis: ['Date'], now: NOW });

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening);
    });

    listening.once('error', reject);
  });

  try {
    const { port } = server.address() as AddressInfo;
    const pages: RenderedPage[] = [];
    let policy = '';

    for (const locale of locales) {
      for (const page of PAGES) {
        const response = await fetch(
          `http://127.0.0.1:${String(port)}/${page.fixture}`,
          { headers: { cookie: `${LOCALE_COOKIE}=${locale}` } },
        );
        const body = await response.text();
        const type = response.headers.get('content-type') ?? '';

        if (response.status !== 200 || !type.startsWith('text/html')) {
          throw new Error(
            `${page.fixture} (${locale}) answered ${String(response.status)} ${type}, expected 200 text/html:\n${body}`,
          );
        }

        policy ||= response.headers.get('content-security-policy') ?? '';
        pages.push({ page, locale, file: fileIn(page, locale), html: body });
      }
    }

    return { pages, policy };
  } finally {
    mock.timers.reset();
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;

    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
};

/**
 * Bundles the mock API into one classic script.
 *
 * Built here rather than by `scripts/build-client.ts`, which writes to the
 * webroot the app serves: the mock must not reach `src/web/public/js`. The
 * options follow the production client build (minified, `keepNames`, ES2022).
 */
const bundleMockApi = async (): Promise<string> => {
  const { outputFiles } = await esbuild.build({
    entryPoints: [MOCK_API_SOURCE],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    minify: true,
    keepNames: true,
    logLevel: 'warning',
  });

  const [bundle] = outputFiles;

  if (!bundle) throw new Error('esbuild produced no mock API bundle');

  return bundle.text;
};

/** A Cloudflare Pages `_redirects` rule. */
interface Redirect {
  from: string;
  to: string;
  status: 200 | 302;
}

/**
 * Rules for the administrator routes a visitor can reach but the demo does not
 * ship a page for.
 *
 * The record pages are POST results in the app (`/admin/lookup/record` and
 * its siblings), so a static host has nothing to serve at them; they are
 * rewritten onto the single fixture that stands for them, and the other form
 * and link targets onto the list page they belong to. The sign-in form is sent
 * to the admin home, which needs no credentials here.
 */
const REDIRECTS: readonly Redirect[] = [
  { from: '/admin/lookup/record', to: '/admin/lookup-detail', status: 200 },
  {
    from: '/admin/redemptions/record',
    to: '/admin/redemptions-detail',
    status: 200,
  },
  {
    from: '/admin/tshirts/record',
    to: '/admin/tshirts-detail',
    status: 200,
  },
  {
    from: '/admin/volunteers/record',
    to: '/admin/volunteers-detail',
    status: 200,
  },
  { from: '/admin/attendees/new', to: '/admin/attendees', status: 200 },
  { from: '/admin/attendees/edit', to: '/admin/attendees', status: 200 },
  { from: '/admin/survey/export.csv', to: '/admin/survey', status: 200 },
  { from: '/', to: '/checkin', status: 302 },
  { from: '/admin/login', to: '/admin', status: 302 },
];

/**
 * The rules for a locale's tree: the pt-BR rules with every path moved into it.
 *
 * The English tree's root is reached both as `/en/` and as `/en`, which the
 * host does not treat as the same path.
 */
const redirectsIn = (locale: DemoLocale): Redirect[] =>
  REDIRECTS.flatMap(({ from, to, status }) => {
    const moved = {
      from: inTree(from, locale),
      to: inTree(to, locale),
      status,
    };

    return from === '/' && moved.from !== from
      ? [moved, { ...moved, from: moved.from.replace(/\/$/, '') }]
      : [moved];
  });

/** Longest value Cloudflare accepts for one response header. */
export const MAX_HEADER_VALUE = 2000;

/**
 * Checks that a header value fits what Cloudflare Pages sends.
 *
 * The policy is one line holding the hashes of every executable inline script and style of
 * every page, so a page that adds one can quietly push it past the cap, which
 * Cloudflare answers by dropping the header or failing the deploy.
 *
 * @param name - The header, for the message.
 * @param value - Its value.
 * @throws {Error} If the value is longer than {@link MAX_HEADER_VALUE}.
 */
export const assertHeaderFits = (name: string, value: string): void => {
  if (value.length > MAX_HEADER_VALUE) {
    throw new Error(
      `${name} is ${String(value.length)} characters, over the ${String(MAX_HEADER_VALUE)} Cloudflare allows in a header value`,
    );
  }
};

/** Root-absolute paths that are not pages, and stay as they are in every tree. */
const NOT_A_PAGE = /^\/(?:api\/|site\.webmanifest$|robots\.txt$)/;

/** A page-linking attribute with a root-absolute value, as `<a href="/x">`. */
const PAGE_LINK = /(\s(?:href|action|formaction)\s*=\s*")(\/(?!\/)[^"]*)"/gi;

/**
 * Points the root-absolute page links and form actions of a page at a locale's
 * tree.
 *
 * Assets, `/api/` paths, the manifest and external links stay as they are, as
 * do links carrying `lang=`, which are language switchers that already name the
 * tree they lead to.
 *
 * @param html - A page with its nonces stripped.
 * @param locale - The tree the page is in.
 */
export const localizeLinks = (html: string, locale: DemoLocale): string =>
  locale === BASE_LOCALE
    ? html
    : html.replace(PAGE_LINK, (whole, lead: string, target: string) => {
        const at = target.search(/[?#]/);
        const pathname = at === -1 ? target : target.slice(0, at);
        const rest = at === -1 ? '' : target.slice(at);

        return ASSET_ROOT.test(pathname) ||
          NOT_A_PAGE.test(pathname) ||
          /(?:[?&]|&amp;)lang=/.test(rest)
          ? whole
          : `${lead}${inTree(pathname, locale)}${rest}"`;
      });

/**
 * Writes the demo site into `outDir`.
 *
 * @param options - See {@link BuildDemoSiteOptions}.
 * @throws {Error} If the client build is missing, a page does not render, a
 *   nonce survives, or a referenced file does not exist.
 */
export const buildDemoSite = async ({
  outDir,
  appTitle,
}: BuildDemoSiteOptions): Promise<BuildDemoSiteResult> => {
  for (const required of REQUIRED_BUILD_OUTPUT) {
    if (!existsSync(path.join(PUBLIC_DIR, required))) {
      throw new Error(
        `src/web/public/${required} is missing: run npm run build first`,
      );
    }
  }

  const { pages, policy: rendered } = await renderPages();

  if (rendered === '') {
    throw new Error('The render sent no Content-Security-Policy');
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const written = new Map<string, number>();

  const write = async (file: string, content: string): Promise<void> => {
    const target = path.join(outDir, file);

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    written.set(file, Buffer.byteLength(content));
  };

  const hashes = { scripts: new Set<string>(), styles: new Set<string>() };
  const seeds = new Set<string>(['/favicon.ico']);

  for (const { page, locale, file, html: markup } of pages) {
    const stripped = stripNonces(markup);

    if (stripped.html.includes('nonce=')) {
      throw new Error(`${file} still carries a nonce after stripping`);
    }

    stripped.scripts.forEach((hash) => hashes.scripts.add(hash));
    stripped.styles.forEach((hash) => hashes.styles.add(hash));

    const other = DEMO_LOCALES.find((candidate) => candidate !== locale);

    if (other === undefined) throw new Error('The demo offers one locale only');

    // After the banner, so its /staff and /admin links follow the tree too.
    const localized = localizeLinks(
      addBanner(
        stripped.html,
        bannerHtml(locale, switchHref(page, other), other),
      ),
      locale,
    );

    referencesOf(`/${file}`, localized)
      .filter(
        (ref) =>
          ASSET_ROOT.test(ref) &&
          ref !== DEMO_CSS_PATH &&
          ref !== MOCK_API_PATH,
      )
      .forEach((ref) => seeds.add(ref));
    await write(file, localized);
  }

  const manifest = siteManifest(appTitle, BASE_LOCALE);

  manifest.icons.forEach((icon) => seeds.add(icon.src));
  await write('site.webmanifest', JSON.stringify(manifest));

  const assets = await copyReferencedAssets(outDir, [...seeds], new Set());

  assets.forEach((size, file) => written.set(file, size));

  await mkdir(path.join(outDir, 'css'), { recursive: true });
  await cp(DEMO_CSS, path.join(outDir, DEMO_CSS_PATH));
  written.set(DEMO_CSS_PATH.slice(1), (await stat(DEMO_CSS)).size);

  await write(MOCK_API_PATH.slice(1), await bundleMockApi());

  const policy = hashPolicy(rendered, {
    scripts: [...hashes.scripts],
    styles: [...hashes.styles],
  });

  if (policy.includes('nonce-')) {
    throw new Error(`The policy still carries a nonce: ${policy}`);
  }

  assertHeaderFits('Content-Security-Policy', policy);

  await write('_headers', headersFile(policy, { 'X-Robots-Tag': 'noindex' }));
  await write(
    '_redirects',
    DEMO_LOCALES.flatMap(redirectsIn)
      .map(({ from, to, status }) => `${from} ${to} ${String(status)}`)
      .concat('')
      .join('\n'),
  );
  await write('robots.txt', 'User-agent: *\nDisallow: /\n');

  return {
    files: [...written.keys()].sort(),
    bytes: [...written.values()].reduce((sum, size) => sum + size, 0),
  };
};

if (import.meta.main) {
  const flag = process.argv.indexOf('--out');
  const outArg = flag === -1 ? undefined : process.argv[flag + 1];

  if (flag !== -1 && (outArg === undefined || outArg.startsWith('--'))) {
    throw new Error('--out needs a directory');
  }

  const outDir = path.resolve(outArg ?? DEFAULT_OUT_DIR);
  const { files, bytes } = await buildDemoSite({
    outDir,
    appTitle: process.env.APP_TITLE ?? 'PelicanPass',
  });

  console.log(
    `Wrote ${String(files.length)} files (${String(bytes)} bytes) to ${outDir}`,
  );
}
