/**
 * Snapshots the post-event closing site into a directory of plain files that
 * Cloudflare Pages can serve with no server behind it.
 *
 * Nothing is re-implemented here: the standalone fallback is started in-process
 * with `closesAt` in the past, its `/`, `/privacy` and `/terms` are fetched and
 * written out, and every asset they reference is copied from `src/web/public`
 * by following the references (HTML, CSS `url()`/`@import`, JS imports), so a
 * stylesheet or chunk added to the closing page is picked up without edits here.
 *
 * The fallback authorises inline scripts with a per-request nonce, which a
 * static file cannot carry. Each nonce is stripped and the script's SHA-256 goes
 * into the `Content-Security-Policy` of the generated `_headers` instead.
 *
 * No `404.html` is written. Without one, Cloudflare Pages answers every unknown
 * path with `/index.html`, so old `/checkin?t=...` and `/pass` links and printed
 * QR codes land on the closing page, exactly as they do on the fallback.
 *
 * Needs the client build (`npm run build`); `npm run build:static` does both.
 * Reads no `.env` and nothing from `config/env.ts`.
 *
 * Usage:
 *   node scripts/static/build.ts                 writes dist/static
 *   node scripts/static/build.ts --out <dir>     writes <dir>
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFallbackApp } from '../../src/fallback/app.ts';
import { BASE_LOCALE } from '../../src/i18n/locales.ts';
import { PERMISSIONS_POLICY } from '../../src/middleware/permissions-policy.middleware.ts';
import { siteManifest } from '../../src/web/content/site-manifest.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'src/web/public');
const DEFAULT_OUT_DIR = path.join(ROOT, 'dist/static');

/**
 * Page paths served by the fallback, and the file each is written to.
 *
 * `privacy.html`, not `privacy/index.html`: Cloudflare Pages serves
 * `/privacy.html` at `/privacy` (and redirects `/privacy.html` there), whereas a
 * directory index is reached by a 308 to `/privacy/`. The footer links to the
 * bare paths.
 */
const PAGES: readonly { route: string; file: string }[] = [
  { route: '/', file: 'index.html' },
  { route: '/privacy', file: 'privacy.html' },
  { route: '/terms', file: 'terms.html' },
];

/** References that are pages or generated files, never copied from the webroot. */
const NOT_ASSETS = new Set([...PAGES.map((p) => p.route), '/site.webmanifest']);

/** Files the build cannot work without; their absence means no client build. */
const REQUIRED_BUILD_OUTPUT = ['css/dist/main.css', 'js/theme/theme.js'];

/** Inputs to {@link buildStaticSite}. */
export interface BuildStaticSiteOptions {
  /** Directory to write; removed and recreated. */
  outDir: string;

  appTitle: string;
}

/** What {@link buildStaticSite} wrote. */
export interface BuildStaticSiteResult {
  /** Paths relative to `outDir`. */
  files: string[];
  bytes: number;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Normalises a reference to a site-absolute path, or `null` when it points off
 * site or at nothing to copy (other origins, `data:`, fragments, bare module
 * specifiers).
 *
 * @param ref - The raw attribute, `url()` or import specifier.
 * @param from - Site-absolute path of the file containing it.
 * @param relativeOnly - Whether a bare specifier is a package, not a path.
 */
const toSitePath = (
  ref: string,
  from: string,
  relativeOnly = false,
): string | null => {
  const value = ref.trim();

  if (value === '' || value.startsWith('#') || value.startsWith('//')) {
    return null;
  }

  if (SCHEME.test(value)) return null;

  if (relativeOnly && !/^(\.{1,2}\/|\/)/.test(value)) return null;

  return decodeURIComponent(new URL(value, `http://site${from}`).pathname);
};

/**
 * Finds every reference `pattern` captures (the first defined group of each
 * match) and normalises it to a site-absolute path.
 */
const collect = (
  text: string,
  pattern: RegExp,
  from: string,
  relativeOnly = false,
): string[] => {
  const found = new Set<string>();

  for (const match of text.matchAll(pattern)) {
    const ref =
      match
        .slice(1)
        // Unmatched alternatives are undefined at runtime, whatever the type says.
        .find((group: string | undefined) => group !== undefined) ?? '';
    const target = toSitePath(ref, from, relativeOnly);

    if (target !== null) found.add(target);
  }

  return [...found];
};

/**
 * Local `href`/`src` targets of an HTML document, as site-absolute paths.
 *
 * @param html - The document.
 * @param from - Site-absolute path it is served at.
 */
export const htmlReferences = (html: string, from: string): string[] =>
  collect(html, /\s(?:href|src)\s*=\s*"([^"]*)"/gi, from);

/**
 * `url()` and `@import` targets of a stylesheet, as site-absolute paths.
 *
 * @param css - The stylesheet.
 * @param from - Site-absolute path it is served at.
 */
export const cssReferences = (css: string, from: string): string[] =>
  collect(
    css,
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi,
    from,
  );

/**
 * Relative or site-absolute module specifiers a script imports, statically or
 * dynamically, as site-absolute paths. esbuild chunks are imported relatively
 * (`../chunks/chunk-XXX.js`); bare package specifiers are ignored.
 *
 * @param js - The script.
 * @param from - Site-absolute path it is served at.
 */
export const jsReferences = (js: string, from: string): string[] =>
  collect(
    js,
    /\b(?:import|export)\b[^'"`;()]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g,
    from,
    true,
  );

/**
 * The references of a file by its extension; empty for types that cannot
 * reference anything (images, fonts).
 *
 * @param file - Site-absolute path of the file.
 * @param text - Its content.
 */
export const referencesOf = (file: string, text: string): string[] => {
  switch (path.posix.extname(file)) {
    case '.html':
      return htmlReferences(text, file);
    case '.css':
      return cssReferences(text, file);
    case '.js':
      return jsReferences(text, file);
    default:
      return [];
  }
};

/**
 * SHA-256 CSP source expression for an inline script or style body.
 *
 * @param text - The element's exact text content.
 */
export const cspHash = (text: string): string =>
  `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

const INLINE_ELEMENT = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const NONCE_ATTRIBUTE = /\s+nonce="[^"]*"/gi;

/**
 * Reports whether a `<script>` runs, so that CSP applies to it.
 *
 * A script with no `type`, an empty one, a JavaScript MIME type or `module` is
 * executed. Any other type, such as `application/json`, makes it a data block,
 * which the HTML spec never prepares for execution, so CSP's inline check does
 * not reach it and it needs no hash.
 *
 * @param attributes - The text between `<script` and `>`.
 */
const isExecutable = (attributes: string): boolean => {
  const type = /\stype\s*=\s*"([^"]*)"/i.exec(attributes)?.[1];

  return (
    type === undefined ||
    ['', 'module', 'text/javascript', 'application/javascript'].includes(
      type.trim().toLowerCase(),
    )
  );
};

/**
 * Removes every `nonce` attribute and returns the CSP hashes of the inline
 * scripts and styles the document carries. Inline data blocks, such as
 * `type="application/json"`, lose their nonce but are not hashed: see
 * {@link isExecutable}.
 *
 * @param html - A rendered page.
 */
export const stripNonces = (
  html: string,
): { html: string; scripts: string[]; styles: string[] } => {
  const scripts: string[] = [];
  const styles: string[] = [];

  for (const [, tag, attributes, body] of html.matchAll(INLINE_ELEMENT)) {
    if (tag === undefined || body === undefined) continue;
    if (tag.toLowerCase() === 'script') {
      if (/\ssrc\s*=/i.test(attributes ?? '')) continue;
      if (!isExecutable(attributes ?? '')) continue;
    }

    (tag.toLowerCase() === 'script' ? scripts : styles).push(cspHash(body));
  }

  return { html: html.replace(NONCE_ATTRIBUTE, ''), scripts, styles };
};

/**
 * Rewrites the fallback's nonce-based policy into the same policy with hashes.
 *
 * Deriving it from the live header, rather than restating it, keeps the static
 * site's policy from drifting when helmet or the fallback changes.
 *
 * @param header - `Content-Security-Policy` as the fallback sent it.
 * @param hashes - Script and style hashes to authorise in place of nonces.
 */
export const hashPolicy = (
  header: string,
  hashes: { scripts: string[]; styles: string[] },
): string =>
  header
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const [name = '', ...sources] = directive.split(/\s+/);
      const kept = sources.filter((source) => !source.startsWith("'nonce-"));

      if (name === 'script-src') kept.push(...hashes.scripts);
      if (name === 'style-src') kept.push(...hashes.styles);

      return [name, ...kept].join(' ');
    })
    .join('; ');

/**
 * Builds the Cloudflare Pages `_headers` file.
 *
 * @param policy - `Content-Security-Policy` value to send on every route.
 * @param extra - Further headers to send on every route, by name.
 */
export const headersFile = (
  policy: string,
  extra: Readonly<Record<string, string>> = {},
): string => {
  const added = Object.entries(extra)
    .map(([name, value]) => `  ${name}: ${value}\n`)
    .join('');

  return `/*
  Content-Security-Policy: ${policy}
  Permissions-Policy: ${PERMISSIONS_POLICY}
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
${added}/site.webmanifest
  Content-Type: application/manifest+json
`;
};

/**
 * Copies the files under `src/web/public` that `seeds` reference, following
 * references inside copied CSS and JS, so only assets in use are shipped.
 *
 * @param outDir - Directory to copy into.
 * @param seeds - Root-absolute paths to start from.
 * @param skip - Root-absolute paths that are pages, not assets.
 * @returns The size in bytes of each file written, keyed by its path relative
 *   to `outDir`.
 * @throws {Error} If a referenced file is not in `src/web/public`.
 */
export const copyReferencedAssets = async (
  outDir: string,
  seeds: readonly string[],
  skip: ReadonlySet<string> = NOT_ASSETS,
): Promise<Map<string, number>> => {
  const queue = [...seeds];
  const copied = new Set<string>();
  const written = new Map<string, number>();

  for (let target = queue.pop(); target !== undefined; target = queue.pop()) {
    if (skip.has(target) || copied.has(target)) continue;

    copied.add(target);

    const source = path.join(PUBLIC_DIR, target);
    const inside = path.relative(PUBLIC_DIR, source);

    if (
      inside.startsWith('..') ||
      !existsSync(source) ||
      !(await stat(source)).isFile()
    ) {
      throw new Error(`${target} is referenced but not in src/web/public`);
    }

    const destination = path.join(outDir, target);

    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
    written.set(target.slice(1), (await stat(source)).size);

    if (/\.(css|js)$/.test(target)) {
      queue.push(...referencesOf(target, await readFile(source, 'utf8')));
    }
  }

  return written;
};

/** Starts the fallback closed for good and hands its pages to `use`. */
const withClosedFallback = async <T>(
  appTitle: string,
  use: (baseUrl: string) => Promise<T>,
): Promise<T> => {
  const app = createFallbackApp({
    port: 0,
    logLevel: 'silent',
    appTitle,
    eventStartAt: 0,
    opensBefore: { participant: 0, volunteer: 0 },
    timezone: 'America/Sao_Paulo',
    closesAt: 0,
  });

  const server = await new Promise<ReturnType<typeof app.listen>>(
    (resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => {
        resolve(listening);
      });

      listening.once('error', reject);
    },
  );

  try {
    const address = server.address();

    if (address === null || typeof address === 'string') {
      throw new Error('The fallback did not bind a TCP port');
    }

    return await use(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
};

/**
 * Writes the closing site into `outDir`.
 *
 * @param options - See {@link BuildStaticSiteOptions}.
 * @throws {Error} If the client build is missing, a page does not render, a
 *   nonce survives, or a referenced file does not exist.
 */
export const buildStaticSite = async ({
  outDir,
  appTitle,
}: BuildStaticSiteOptions): Promise<BuildStaticSiteResult> => {
  for (const required of REQUIRED_BUILD_OUTPUT) {
    if (!existsSync(path.join(PUBLIC_DIR, required))) {
      throw new Error(
        `src/web/public/${required} is missing: run npm run build first`,
      );
    }
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
  const pages = new Map<string, string>();
  let fallbackPolicy = '';

  await withClosedFallback(appTitle, async (baseUrl) => {
    for (const { route, file } of PAGES) {
      const response = await fetch(`${baseUrl}${route}`);
      const type = response.headers.get('content-type') ?? '';

      if (response.status !== 200 || !type.startsWith('text/html')) {
        throw new Error(
          `${route} answered ${String(response.status)} ${type}, expected 200 text/html`,
        );
      }

      fallbackPolicy ||= response.headers.get('content-security-policy') ?? '';

      const stripped = stripNonces(await response.text());

      if (stripped.html.includes('nonce=')) {
        throw new Error(`${route} still carries a nonce after stripping`);
      }

      stripped.scripts.forEach((hash) => hashes.scripts.add(hash));
      stripped.styles.forEach((hash) => hashes.styles.add(hash));
      pages.set(file, stripped.html);
      await write(file, stripped.html);
    }
  });

  if (fallbackPolicy === '') {
    throw new Error('The fallback sent no Content-Security-Policy');
  }

  const manifest = siteManifest(appTitle, BASE_LOCALE);

  await write('site.webmanifest', JSON.stringify(manifest));

  const assets = await copyReferencedAssets(outDir, [
    '/favicon.ico',
    ...manifest.icons.map((icon) => icon.src),
    ...PAGES.flatMap(({ file }) =>
      referencesOf(`/${file}`, pages.get(file) ?? ''),
    ),
  ]);

  assets.forEach((size, file) => written.set(file, size));

  const policy = hashPolicy(fallbackPolicy, {
    scripts: [...hashes.scripts],
    styles: [...hashes.styles],
  });

  if (policy.includes('nonce-')) {
    throw new Error(`The policy still carries a nonce: ${policy}`);
  }

  await write('_headers', headersFile(policy));

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
  const { files, bytes } = await buildStaticSite({
    outDir,
    appTitle: process.env.APP_TITLE ?? 'PelicanPass',
  });

  console.log(
    `Wrote ${String(files.length)} files (${String(bytes)} bytes) to ${outDir}`,
  );
}
