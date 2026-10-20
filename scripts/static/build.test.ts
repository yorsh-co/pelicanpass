import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { getMessages } from '../../src/i18n/catalogs.ts';
import { BASE_LOCALE } from '../../src/i18n/locales.ts';
import { NOTICES } from '../../src/web/content/notices.ts';
import { siteManifest } from '../../src/web/content/site-manifest.ts';
import {
  buildStaticSite,
  cspHash,
  referencesOf,
  stripNonces,
} from './build.ts';

const MAIN_CSS = fileURLToPath(
  new URL('../../src/web/public/css/dist/main.css', import.meta.url),
);
const APP_TITLE = 'PelicanPass';

/** Every file under `dir`, as a path relative to it. */
const listFiles = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)),
    );

describe('stripNonces', () => {
  it('hashes inline scripts and drops the nonce', () => {
    const body = "\n  localStorage.getItem('theme');\n";
    const result = stripNonces(
      `<script nonce="abc">${body}</script><script src="/a.js"></script>`,
    );

    assert.equal(result.html.includes('nonce'), false);
    assert.deepEqual(result.scripts, [cspHash(body)]);
    assert.deepEqual(result.styles, []);
  });

  it('hashes inline styles apart from scripts', () => {
    const result = stripNonces('<style nonce="abc">a{}</style>');

    assert.equal(result.html, '<style>a{}</style>');
    assert.deepEqual(result.styles, [cspHash('a{}')]);
  });
});

describe('referencesOf', () => {
  it('follows css url() and @import but not off-site or data URIs', () => {
    assert.deepEqual(
      referencesOf(
        '/css/dist/main.css',
        '@import "./x.css"; a{background:url(../f.woff2)} b{background:url("data:image/png;base64,AA")} c{background:url(https://e.com/a.png)}',
      ),
      ['/css/dist/x.css', '/css/f.woff2'],
    );
  });

  it('follows static and dynamic imports but not packages', () => {
    assert.deepEqual(
      referencesOf(
        '/js/theme/theme.js',
        'import{a}from"../chunks/c.js";import"./s.js";export*from"/js/e.js";import("./d.js");import x from"pkg";',
      ),
      ['/js/chunks/c.js', '/js/theme/s.js', '/js/e.js', '/js/theme/d.js'],
    );
  });
});

describe(
  'buildStaticSite',
  { skip: !existsSync(MAIN_CSS) && 'client build missing: run npm run build' },
  () => {
    let outDir = '';
    let files: string[] = [];

    const read = (file: string): Promise<string> =>
      readFile(path.join(outDir, file), 'utf8');

    before(async () => {
      outDir = await mkdtemp(path.join(tmpdir(), 'static-site-'));
      await buildStaticSite({ outDir, appTitle: APP_TITLE });
      files = await listFiles(outDir);
    });

    after(async () => {
      await rm(outDir, { recursive: true, force: true });
    });

    it('writes the pages, manifest and headers but no 404.html', () => {
      for (const file of [
        'index.html',
        'privacy.html',
        'terms.html',
        'site.webmanifest',
        '_headers',
      ]) {
        assert.ok(files.includes(file), `${file} missing`);
      }

      assert.equal(files.includes('404.html'), false);
    });

    it('renders the closing page, privacy notice and terms', async () => {
      const closed = getMessages(BASE_LOCALE, 'landing').closedTitle();

      assert.match(await read('index.html'), new RegExp(closed));
      assert.ok(
        (await read('privacy.html')).includes(NOTICES[BASE_LOCALE].privacy),
      );
      assert.ok(
        (await read('terms.html')).includes(NOTICES[BASE_LOCALE].terms),
      );
    });

    it('carries no nonce anywhere', async () => {
      const text = files.filter((file) =>
        /\.(html|css|js|webmanifest)$|^_headers$/.test(file),
      );

      for (const file of text) {
        assert.equal(
          (await read(file)).includes('nonce'),
          false,
          `${file} mentions a nonce`,
        );
      }
    });

    it('authorises every inline script by hash', async () => {
      const policy = /Content-Security-Policy: (.*)/.exec(
        await read('_headers'),
      )?.[1];

      assert.ok(policy);

      let inline = 0;

      for (const page of ['index.html', 'privacy.html', 'terms.html']) {
        const { scripts } = stripNonces(await read(page));

        for (const hash of scripts) {
          inline += 1;
          assert.ok(policy.includes(hash), `${page}: ${hash} not in policy`);
        }
      }

      assert.ok(inline > 0, 'no inline script found to check');
    });

    it('resolves every local reference to a shipped file', async () => {
      const pages = new Set(['/', '/privacy', '/terms']);

      for (const file of files) {
        const site = `/${file.split(path.sep).join('/')}`;
        const refs = referencesOf(site, await read(file));

        for (const ref of refs) {
          const shipped = pages.has(ref) || files.includes(ref.slice(1));

          assert.ok(shipped, `${site} references ${ref}, which is not shipped`);
        }
      }
    });

    it('ships no page bundle', () => {
      assert.deepEqual(
        files.filter((file) => file.startsWith('js/pages/')),
        [],
      );
    });

    it('writes the live app manifest', async () => {
      assert.deepEqual(
        JSON.parse(await read('site.webmanifest')),
        siteManifest(APP_TITLE, BASE_LOCALE),
      );
    });
  },
);
