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
import {
  DEMO_ROSTER,
  DEMO_TICKET_CODES,
  DEMO_VERIFICATION_CODE,
} from '../../src/web/client/demo/roster.ts';
import { isCovered } from '../../src/web/client/demo/routes.ts';
import { referencesOf, stripNonces } from '../static/build.ts';

const PUBLIC_DIR = fileURLToPath(
  new URL('../../src/web/public', import.meta.url),
);
const MAIN_CSS = path.join(PUBLIC_DIR, 'css/dist/main.css');

const PAGE_FILES = [
  'checkin.html',
  'pass.html',
  'pass-volunteer.html',
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
  'admin/tshirts-detail.html',
  'admin/volunteers.html',
  'admin/volunteers-detail.html',
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

/** The mock API's bundle, as the pages load it. */
const MOCK_API = '/js/demo/mock-api.js';

/**
 * Where the mock's script tag sits among a page's other scripts, comments
 * excluded: the index of the first `<script` that is not inside one.
 */
const firstScriptTag = (html: string): string | undefined => {
  const tokens = /<!--[\s\S]*?-->|<script\b[^>]*>/gi;

  for (const [token] of html.matchAll(tokens)) {
    if (!token.startsWith('<!--')) return token;
  }

  return undefined;
};

/**
 * Every `/api/v1/` path a script mentions, with `${…}` segments replaced by `*`
 * and a trailing slash dropped, so the result is comparable to a route.
 */
const apiPathsIn = (js: string): string[] => {
  const paths: string[] = [];
  let at = js.indexOf('/api/v1/');

  while (at !== -1) {
    let path = '';
    let i = at;

    while (i < js.length && !/["'`\s?\\]/.test(js.charAt(i))) {
      if (js.startsWith('${', i)) {
        let depth = 1;

        i += 2;

        while (i < js.length && depth > 0) {
          depth += js.charAt(i) === '{' ? 1 : js.charAt(i) === '}' ? -1 : 0;
          i += 1;
        }

        path += '*';
      } else {
        path += js.charAt(i);
        i += 1;
      }
    }

    paths.push(path.replace(/\/$/, ''));
    at = js.indexOf('/api/v1/', i);
  }

  return paths;
};

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

  it('lists the banner codes among the attendees, unchecked in', () => {
    for (const role of ['participant', 'volunteer'] as const) {
      for (const code of DEMO_TICKET_CODES[role]) {
        const entry = DEMO_ROSTER.find((person) => person.code === code);

        assert.equal(entry?.role, role, code);
        assert.equal(entry.checkedIn, false, code);
      }
    }
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
        assert.ok(
          html.includes('href="/admin"'),
          `${page} lacks the admin link`,
        );
        assert.ok(html.includes('href="/css/demo.css"'), `${page} lacks css`);

        for (const code of [
          ...DEMO_TICKET_CODES.participant,
          ...DEMO_TICKET_CODES.volunteer,
        ]) {
          assert.ok(html.includes(code.toUpperCase()), `${page} lacks ${code}`);
        }
      }
    });

    it('loads the mock API before any other script, as a classic script', async () => {
      for (const page of files.filter((file) => file.endsWith('.html'))) {
        const tag = firstScriptTag(await read(page));

        assert.ok(tag, `${page} has no script`);
        assert.ok(tag.includes(`src="${MOCK_API}"`), `${page}: ${tag}`);
        assert.doesNotMatch(tag, /\b(?:type|defer|async)\b/, page);
      }

      assert.ok(files.includes(MOCK_API.slice(1)));
    });

    it('renders the reset button, hidden until the mock binds it', async () => {
      for (const page of files.filter((file) => file.endsWith('.html'))) {
        assert.match(
          await read(page),
          /<button[^>]*\bdata-demo-reset\b[^>]*\bhidden\b[^>]*>/,
          page,
        );
      }
    });

    it('tells the visitor the verification digits', async () => {
      assert.ok((await read('checkin.html')).includes(DEMO_VERIFICATION_CODE));
    });

    it('gives a volunteer a pass of their own, with the team line', async () => {
      assert.match(
        await read('pass-volunteer.html'),
        /data-audience="volunteer"/,
      );
      assert.match(await read('pass.html'), /data-audience="participant"/);
    });

    it('has a handler or a refusal for every API path the bundles call', async () => {
      const scripts = files.filter(
        (file) =>
          file.startsWith('js/') &&
          file.endsWith('.js') &&
          !file.startsWith('js/demo/'),
      );
      const paths = new Set<string>();

      for (const file of scripts) {
        apiPathsIn(await read(file)).forEach((found) => paths.add(found));
      }

      assert.ok(paths.size >= 20, `only ${String(paths.size)} paths found`);
      assert.ok(paths.has('/api/v1/checkin/ticket'));
      assert.ok(
        [...paths].some((found) => found.includes('*')),
        'no template-literal path found',
      );

      const uncovered = [...paths].filter((found) => !isCovered(found));

      assert.deepEqual(uncovered, [], 'paths the mock does not answer');
    });

    it('opens the metrics dashboard with every dependency healthy', async () => {
      const metrics = await read('admin/metrics.html');

      assert.match(metrics, /panel__status--ok/);
      assert.doesNotMatch(metrics, /panel__status--down/);
    });

    it('has no escaping-test markers in any page text', async () => {
      for (const page of files.filter((file) => file.endsWith('.html'))) {
        const text = (await read(page))
          .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
          .replace(/<!--[\s\S]*?-->/g, '');
        const nodes = [...text.matchAll(/>([^<]*)(?=<|$)/g)].map(
          (match) => match[1] ?? '',
        );

        assert.deepEqual(
          nodes.filter((node) => /&lt;|&gt;/.test(node)),
          [],
          page,
        );
        assert.doesNotMatch(text.replace(/<[^>]*>/g, ''), /[<>]/, page);
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
