import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Before anything that loads `config/env.ts`, so the pages render as deployed.
import { REPOSITORY_URL, buildDemoSite } from './build.ts';

import { isValidTicketCode } from '../../src/constants/ticket.ts';
import { DEMO_TICKET_CODES } from '../../src/web/client/demo/roster.ts';
import { referencesOf, stripNonces } from '../static/build.ts';

const PUBLIC_DIR = fileURLToPath(
  new URL('../../src/web/public', import.meta.url),
);
const MAIN_CSS = path.join(PUBLIC_DIR, 'css/dist/main.css');

const PAGE_FILES = [
  'checkin.html',
  'pass.html',
  'staff.html',
  'raffle.html',
  'privacy.html',
  'terms.html',
  '404.html',
  'admin.html',
  'admin/metrics.html',
  'admin/attendees.html',
  'admin/lookup.html',
  'admin/lookup-detail.html',
  'admin/redemptions.html',
  'admin/redemptions-detail.html',
  'admin/tshirts.html',
  'admin/volunteers.html',
  'admin/survey.html',
  'admin/whatsapp.html',
  'admin/pass.html',
];

/** Every file under `dir`, as a posix path relative to it. */
const listFiles = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(dir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/'),
    );

/** Escapes a `_redirects` source into a pattern, `*` matching any suffix. */
const ruleMatcher = (source: string): RegExp =>
  new RegExp(
    `^${source
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );

describe('roster', () => {
  it('lists well-formed, distinct ticket codes', () => {
    const codes = [
      ...DEMO_TICKET_CODES.participant,
      ...DEMO_TICKET_CODES.volunteer,
    ];

    assert.ok(codes.every(isValidTicketCode));
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe('production client bundle', () => {
  it('holds no demo code', () => {
    assert.equal(existsSync(path.join(PUBLIC_DIR, 'js/demo')), false);
  });
});

describe(
  'buildDemoSite',
  { skip: !existsSync(MAIN_CSS) && 'client build missing: run npm run build' },
  () => {
    let outDir = '';
    let files: string[] = [];

    const read = (file: string): Promise<string> =>
      readFile(path.join(outDir, file), 'utf8');

    before(async () => {
      outDir = await mkdtemp(path.join(tmpdir(), 'demo-site-'));
      await buildDemoSite({ outDir, appTitle: 'PelicanPass' });
      files = await listFiles(outDir);
    });

    after(async () => {
      await rm(outDir, { recursive: true, force: true });
    });

    it('writes every page and the generated files', () => {
      for (const file of [
        ...PAGE_FILES,
        'site.webmanifest',
        'robots.txt',
        '_headers',
        '_redirects',
        'css/demo.css',
        'js/pages/attendee/checkin/index.js',
      ]) {
        assert.ok(files.includes(file), `${file} missing`);
      }
    });

    it('ships no landing page and sends / to check-in', async () => {
      assert.equal(files.includes('index.html'), false);
      assert.match(await read('_redirects'), /^\/ \/checkin 302$/m);
    });

    it('shows the real admin labels and the package release', async () => {
      const { version } = JSON.parse(
        await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as { version: string };

      assert.doesNotMatch(await read('admin.html'), />\s*metrics\s*</);
      assert.ok((await read('admin/metrics.html')).includes(`v${version}`));
      assert.doesNotMatch(await read('404.html'), /&lt;ou&gt;/);
    });

    it('renders as deployed, with no language switcher', async () => {
      assert.doesNotMatch(await read('pass.html'), /footer-locales/);
      assert.doesNotMatch(await read('pass.html'), /data-nodeenv="test"/);
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

    it('authorises every inline script and style by hash', async () => {
      const policy = /Content-Security-Policy: (.*)/.exec(
        await read('_headers'),
      )?.[1];

      assert.ok(policy);

      let inline = 0;

      for (const page of PAGE_FILES) {
        const html = await read(page);
        const { scripts, styles } = stripNonces(html);

        for (const hash of [...scripts, ...styles]) {
          inline += 1;
          assert.ok(policy.includes(hash), `${page}: ${hash} not in policy`);
        }
      }

      assert.ok(inline > 0, 'no inline script or style found to check');
    });

    it('resolves every local href, src and action', async () => {
      const rules = (await read('_redirects'))
        .split('\n')
        .filter(Boolean)
        .map((line) => ruleMatcher(line.split(/\s+/)[0] ?? ''));

      const resolves = (target: string): boolean =>
        files.includes(target.slice(1)) ||
        files.includes(`${target.slice(1)}.html`) ||
        rules.some((rule) => rule.test(target));

      for (const page of files.filter((file) => file.endsWith('.html'))) {
        const site = `/${page}`;
        const html = await read(page);
        const actions = [...html.matchAll(/\saction\s*=\s*"([^"]*)"/gi)].map(
          ([, ref]) => new URL(ref ?? '', `http://site${site}`).pathname,
        );

        for (const ref of [...referencesOf(site, html), ...actions]) {
          assert.ok(resolves(ref), `${site} references ${ref}, not shipped`);
        }
      }

      for (const file of files.filter((name) => /\.(css|js)$/.test(name))) {
        for (const ref of referencesOf(`/${file}`, await read(file))) {
          assert.ok(files.includes(ref.slice(1)), `/${file} -> ${ref} missing`);
        }
      }
    });

    it('puts the banner on every page, after the opening body tag', async () => {
      for (const page of files.filter((file) => file.endsWith('.html'))) {
        const html = await read(page);

        assert.match(
          html,
          /<body\b[^>]*>\s*<aside class="demo-banner" role="note">/,
          `${page} lacks the banner`,
        );
        assert.ok(html.includes(REPOSITORY_URL), `${page} lacks the repo link`);
        assert.ok(html.includes('href="/css/demo.css"'), `${page} lacks css`);

        for (const code of [
          ...DEMO_TICKET_CODES.participant,
          ...DEMO_TICKET_CODES.volunteer,
        ]) {
          assert.ok(html.includes(code.toUpperCase()), `${page} lacks ${code}`);
        }
      }
    });

    it('asks crawlers to stay away', async () => {
      assert.match(await read('_headers'), /^ {2}X-Robots-Tag: noindex$/m);
      assert.equal(await read('robots.txt'), 'User-agent: *\nDisallow: /\n');
    });

    it('keeps the sign-in redirect and rewrites out of the page files', async () => {
      const redirects = await read('_redirects');

      assert.match(redirects, /^\/admin\/login \/admin 302$/m);
      assert.match(
        redirects,
        /^\/admin\/lookup\/record \/admin\/lookup-detail 200$/m,
      );
    });
  },
);
