/**
 * Bundles browser code from src/web/client into src/web/public/js, and the
 * stylesheets under src/web/public/css into one file per document.
 *
 * Sources live outside the webroot so express.static can never serve an
 * unbuilt .ts file; the bundler is what puts JavaScript under /js. Output
 * paths mirror source paths, so the <script src="/js/..."> tags in the EJS
 * views are the same before and after the TypeScript migration.
 *
 * Usage:
 *   node scripts/build-client.ts            one-shot development build
 *   node scripts/build-client.ts --watch     rebuild on change
 *   node scripts/build-client.ts --prod      minified, no sourcemaps
 */

import { globSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const SRC_DIR = fileURLToPath(new URL('../src/web/client', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('../src/web/public/js', import.meta.url));

const CSS_DIR = fileURLToPath(
  new URL('../src/web/public/css', import.meta.url),
);
const CSS_OUT_DIR = fileURLToPath(
  new URL('../src/web/public/css/dist', import.meta.url),
);

/**
 * Stylesheet entry points: the shared shell plus one per page that declares its
 * own via `contentFor('styles')`.
 *
 * These were served as-authored, so `main.css`'s twenty-two `@import`s became
 * twenty-two *serial* round trips — each file discovered only once its importer
 * had arrived — at the door, on the worst network the app ever sees. esbuild
 * flattens each entry to a single request.
 */
const CSS_ENTRIES = [
  'main.css',
  'pages/error.css',
  'pages/landing.css',
  'pages/notice.css',
  'pages/attendee/checkin.css',
  'pages/attendee/pass.css',
  'pages/attendee/staff.css',
  'pages/attendee/raffle.css',
  'pages/admin.css',
  'pages/admin/attendees.css',
  'pages/admin/lookup.css',
  'pages/admin/metrics.css',
  'pages/admin/whatsapp.css',
  'pages/admin/survey.css',
  'pages/admin/pass.css',
  'pages/admin/redemptions.css',
  'pages/admin/tshirts.css',
  'pages/admin/volunteers.css',
];

/**
 * Page entry points: one bundle per document. Every other module under
 * src/web/client is shared code and is pulled in through imports.
 */
const ENTRY_PATTERNS = [
  'pages/**/index.{ts,js}',
  'theme/*.{ts,js}',
  // The global error reporter. Like `theme/`, it is loaded from the layouts on
  // every page rather than imported by one, so it has to be an entry point of
  // its own — a module under `core/` is only ever reached through an import and
  // would 404 as a `<script src>`.
  'telemetry/*.{ts,js}',
];

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');

/**
 * Resolves the page entry points to bundle.
 *
 * @returns Absolute paths, sorted for stable build logs.
 * @throws {Error} If no entry point matches, which always means a broken build.
 */
function findEntryPoints(): string[] {
  const entries = ENTRY_PATTERNS.flatMap((pattern) =>
    globSync(pattern, { cwd: SRC_DIR }),
  ).map((relative) => `${SRC_DIR}/${relative}`);

  if (entries.length === 0) {
    throw new Error(
      `No client entry points matched ${ENTRY_PATTERNS.join(', ')} in ${SRC_DIR}`,
    );
  }

  return entries.sort();
}

const options: esbuild.BuildOptions = {
  entryPoints: findEntryPoints(),
  outdir: OUT_DIR,
  // Anchors output paths to the source root so pages/attendee/checkin/index.ts
  // lands at /js/pages/attendee/checkin/index.js rather than being flattened.
  outbase: SRC_DIR,
  bundle: true,
  format: 'esm',
  // Lets `await import('html5-qrcode')` in modules/qr.ts land in its own chunk
  // instead of being inlined into the check-in bundle. Requires format: 'esm'.
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: 'es2022',
  platform: 'browser',
  // Catalogs are precompiled to ASTs by scripts/i18n/build.ts, so the ICU
  // parser that intl-messageformat imports is dead weight in the browser.
  alias: {
    '@formatjs/icu-messageformat-parser':
      '@formatjs/icu-messageformat-parser/no-parser.js',
  },
  minify: prod,
  // Survives minification, unlike the rest of the identifiers. Without it a
  // production stack trace names `t`, `n` and `o`, which is indistinguishable
  // from no stack trace at all.
  //
  // Measured across all 21 output files: 442,150 B to 455,480 B raw, and
  // 138,786 B to 142,659 B gzipped — +3,873 B over the wire, +2.8%. esbuild
  // implements it by wrapping each definition in a helper that reasserts
  // `.name`, which is why the cost scales with the number of functions rather
  // than being a fixed preamble. Bought instead of source maps, which would
  // need a post-build move out of the webroot and something to resolve them.
  keepNames: true,
  sourcemap: !prod,
  logLevel: 'info',
};

/**
 * Bundling `pages/attendee/checkin.css` would inline `main.css` into it if the
 * page stylesheet imported it, so page entries stay independent of the shell —
 * they are additive layers, and the document links both.
 */
const cssOptions: esbuild.BuildOptions = {
  entryPoints: CSS_ENTRIES.map((entry) => `${CSS_DIR}/${entry}`),
  outdir: CSS_OUT_DIR,
  outbase: CSS_DIR,
  bundle: true,
  // `external` for anything the CSS references by URL: fonts and images are
  // served from /assets and must stay pointing there rather than being copied
  // into the output directory and rewritten.
  external: ['/assets/*'],
  loader: { '.woff2': 'file' },
  minify: prod,
  sourcemap: !prod,
  logLevel: 'info',
};

await rm(OUT_DIR, { recursive: true, force: true });
await rm(CSS_OUT_DIR, { recursive: true, force: true });

if (watch) {
  const jsContext = await esbuild.context(options);
  const cssContext = await esbuild.context(cssOptions);

  await jsContext.watch();
  await cssContext.watch();

  console.log(`watching ${SRC_DIR} and ${CSS_DIR}`);
} else {
  await esbuild.build(options);
  await esbuild.build(cssOptions);
}
