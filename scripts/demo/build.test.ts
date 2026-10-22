import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Before anything that loads `config/env.ts`, so the pages render as deployed.
import {
  MAX_HEADER_VALUE,
  REPOSITORY_URL,
  assertHeaderFits,
  buildDemoSite,
  localizeLinks,
} from './build.ts';

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

const PT_PAGE_FILES = [
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

const EN_PAGE_FILES = PT_PAGE_FILES.map((file) => `en/${file}`);
const PAGE_FILES = [...PT_PAGE_FILES, ...EN_PAGE_FILES];

/** The pt-BR copy of the banner and a phrase of it that English pages must not carry. */
const PT_BANNER_PHRASES = [
  'Demonstração',
  'Reiniciar demonstração',
  'Detalhes',
];

/** The path a served file answers at: `admin/pass.html` at `/admin/pass`. */
const servedAt = (file: string): string => `/${file.replace(/\.html$/, '')}`;

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

describe('assertHeaderFits', () => {
  it('accepts a value at the limit', () => {
    assert.doesNotThrow(() => {
      assertHeaderFits('X', 'a'.repeat(MAX_HEADER_VALUE));
    });
  });

  it('throws, naming the header and the length, one character over', () => {
    assert.throws(() => {
      assertHeaderFits('Content-Security-Policy', 'a'.repeat(2001));
    }, /Content-Security-Policy is 2001 characters/);
  });
});

describe('localizeLinks', () => {
  const page = (html: string): string => localizeLinks(html, 'en');

  it('moves page links and form actions into the English tree', () => {
    assert.equal(page('<a href="/privacy">'), '<a href="/en/privacy">');
    assert.equal(page('<a href="/">'), '<a href="/en/">');
    assert.equal(
      page('<form action="/admin/lookup/record" method="post">'),
      '<form action="/en/admin/lookup/record" method="post">',
    );
    assert.equal(
      page('<a href="/checkin?audience=volunteer#x">'),
      '<a href="/en/checkin?audience=volunteer#x">',
    );
  });

  it('leaves assets, the API, the manifest, external links and switchers alone', () => {
    for (const html of [
      '<link href="/css/dist/main.css">',
      '<link href="/assets/a.png">',
      '<link href="/js/theme/theme.js">',
      '<link rel="icon" href="/favicon.ico">',
      '<link rel="manifest" href="/site.webmanifest">',
      '<a href="/api/v1/x">',
      '<a href="https://example.com/a">',
      '<a href="//example.com/a">',
      '<a href="?lang=en">',
      '<a href="/privacy?lang=pt-BR">',
      '<a href="/checkin?a=1&amp;lang=pt-BR">',
      '<a href="relative">',
      '<img src="/assets/a.png">',
    ]) {
      assert.equal(page(html), html);
    }
  });

  it('leaves the pt-BR tree untouched', () => {
    assert.equal(
      localizeLinks('<a href="/privacy">', 'pt-BR'),
      '<a href="/privacy">',
    );
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

    it('serves the countdown at /landing and sends / to check-in', async () => {
      assert.equal(files.includes('index.html'), false);
      assert.ok(files.includes('landing.html'), 'landing.html missing');
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

    it('renders as deployed, with no development markers', async () => {
      assert.doesNotMatch(await read('pass.html'), /data-nodeenv="test"/);
      assert.doesNotMatch(await read('en/pass.html'), /data-nodeenv="test"/);
    });

    it('writes an English tree with a page for every pt-BR page', () => {
      for (const file of EN_PAGE_FILES) {
        assert.ok(files.includes(file), `${file} missing`);
      }
    });

    it('sets the page language of each tree, and never the pseudo-locale', async () => {
      for (const file of PT_PAGE_FILES) {
        assert.match(await read(file), /<html lang="pt-BR"/, file);
      }

      for (const file of EN_PAGE_FILES) {
        assert.match(await read(file), /<html lang="en"/, file);
      }
    });

    it('bakes the date locale the browser reads into each page', async () => {
      for (const file of PT_PAGE_FILES) {
        assert.match(
          await read(file),
          /<html [^>]*data-date-locale="pt-BR"/,
          file,
        );
      }

      for (const file of EN_PAGE_FILES) {
        assert.match(
          await read(file),
          /<html [^>]*data-date-locale="en-GB-u-hc-h23"/,
          file,
        );
      }

      assert.ok(
        files.every((file) => !file.startsWith('en-XA/')),
        'a pseudo-locale tree was written',
      );
    });

    it('translates the page itself, not only the banner', async () => {
      assert.match(await read('en/checkin.html'), /Already checked in/i);
      assert.doesNotMatch(await read('en/checkin.html'), /Digite o código/);
      assert.match(await read('checkin.html'), /Digite/);
    });

    it('links each switcher to the matching page of the other tree', async () => {
      for (const file of PT_PAGE_FILES) {
        if (file === '404.html') continue;

        const here = servedAt(file);
        const pt = await read(file);
        const en = await read(`en/${file}`);

        for (const html of [pt, en]) {
          assert.ok(
            html.includes(`href="${here}?lang=pt-BR"`),
            `${file} lacks the pt-BR switcher link`,
          );
          assert.ok(
            html.includes(`href="/en${here === '/' ? '/' : here}?lang=en"`),
            `${file} lacks the English switcher link`,
          );
        }

        assert.match(
          pt,
          /<a\s[^>]*aria-current="true"[^>]*>\s*<span[^>]*>BR</,
          file,
        );
        assert.match(
          en,
          /<a\s[^>]*aria-current="true"[^>]*>\s*<span[^>]*>EN</,
          file,
        );
      }
    });

    it('lets the not-found page switch tree in place', async () => {
      for (const file of ['404.html', 'en/404.html']) {
        const html = await read(file);

        assert.ok(html.includes('href="?lang=en"'), file);
        assert.ok(html.includes('href="?lang=pt-BR"'), file);
      }
    });

    it('never doubles the English prefix', async () => {
      assert.doesNotMatch(await read('en/pass.html'), /\/en\/en\//);
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

    it('puts the banner on every page, after the opening body tag, in its language', async () => {
      for (const page of files.filter((file) => file.endsWith('.html'))) {
        const html = await read(page);
        const english = page.startsWith('en/');
        const prefix = english ? '/en' : '';
        const other = english ? 'pt-BR' : 'en';

        assert.match(
          html,
          /<body\b[^>]*>\s*<aside class="demo-banner" role="note">/,
          `${page} lacks the banner`,
        );
        assert.equal(
          html.split('<aside class="demo-banner"').length,
          2,
          `${page} has more than one banner`,
        );

        const banner = /<aside class="demo-banner"[\s\S]*?<\/aside>/.exec(
          html,
        )?.[0];

        assert.ok(banner, page);

        for (const needle of [
          REPOSITORY_URL,
          `href="${prefix}/staff"`,
          `href="${prefix}/admin"`,
          'href="/css/demo.css"',
          ...[
            ...DEMO_TICKET_CODES.participant,
            ...DEMO_TICKET_CODES.volunteer,
          ].map((code) => code.toUpperCase()),
        ]) {
          assert.ok(
            needle === 'href="/css/demo.css"'
              ? html.includes(needle)
              : banner.includes(needle),
            `${page} lacks ${needle}`,
          );
        }

        for (const phrase of PT_BANNER_PHRASES) {
          assert.equal(
            banner.includes(phrase),
            !english,
            `${page}: "${phrase}" in the wrong language`,
          );
        }

        assert.equal(banner.includes('Demo.'), english, page);
        assert.match(
          banner,
          new RegExp(`<a class="demo-banner-button" href="[^"]*lang=${other}"`),
          `${page} lacks the language link`,
        );
        assert.doesNotMatch(banner, /data-demo-copy|data-demo-set-lang/, page);
      }
    });

    it('renders one collapse toggle, controlling the details, hidden until bound', async () => {
      for (const page of files.filter((file) => file.endsWith('.html'))) {
        const html = await read(page);
        const toggle = /<button[^>]*\bdata-demo-banner-toggle\b[^>]*>/.exec(
          html,
        )?.[0];

        assert.ok(toggle, `${page} lacks the toggle`);
        assert.match(toggle, /\bhidden\b/, `${page} toggle shown`);
        assert.ok(
          toggle.includes('aria-controls="demo-banner-details"'),
          `${page} toggle controls the wrong element`,
        );
        assert.ok(
          html.includes('id="demo-banner-details"'),
          `${page} lacks the details it controls`,
        );
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

    it('shows English sample data on the English pages only', async () => {
      const samples =
        /Vegetariano|Sem restrição|Suco de laranja|Frango|Recepção|Líder|operadora|Fila de check-in/;
      const pages = files.filter((file) => file.endsWith('.html'));
      const textOf = async (tree: string[]): Promise<string> =>
        (await Promise.all(tree.map(read))).join('\n');
      const english = await textOf(pages.filter((f) => f.startsWith('en/')));
      const portuguese = await textOf(
        pages.filter((f) => !f.startsWith('en/')),
      );

      assert.doesNotMatch(english, samples);
      assert.match(portuguese, /Vegetariano/);
      assert.match(portuguese, /Recepção/);
      assert.match(portuguese, /operadora/);
      assert.match(portuguese, /Fila de check-in acima do normal/);
      assert.match(await read('en/pass-volunteer.html'), /Reception/);
      assert.match(
        await read('en/admin/metrics.html'),
        /Check-in queue above normal/,
      );
      assert.match(await read('en/admin/metrics.html'), />operator</);
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

    it('never links an English page to a pt-BR page', async () => {
      const rules = (await read('_redirects'))
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(/\s+/)[0] ?? '');

      for (const page of files.filter((file) => file.startsWith('en/'))) {
        const html = await read(page);
        const actions = [
          ...html.matchAll(/\s(?:action|formaction)\s*=\s*"([^"]*)"/gi),
        ].map(([, ref]) => ref ?? '');
        const hrefs = [...html.matchAll(/\shref\s*=\s*"([^"]*)"/gi)].map(
          ([, ref]) => ref ?? '',
        );

        for (const ref of [...hrefs, ...actions]) {
          if (!ref.startsWith('/') || ref.startsWith('//')) continue;
          if (/[?&]lang=/.test(ref)) continue;

          const target = ref.split(/[?#]/)[0] ?? '';

          if (
            /^\/(?:assets|css|js)\//.test(target) ||
            ['/favicon.ico', '/site.webmanifest'].includes(target)
          ) {
            continue;
          }

          assert.ok(
            target === '/en' || target.startsWith('/en/'),
            `${page} links to ${ref}`,
          );
        }
      }

      assert.ok(rules.includes('/en/'), 'the English root has no rule');
    });

    it('mirrors every redirect and rewrite under /en', async () => {
      const lines = (await read('_redirects')).split('\n').filter(Boolean);
      const plain = lines.filter((line) => !line.startsWith('/en'));

      for (const line of plain) {
        const [from = '', to = '', status = ''] = line.split(/\s+/);
        const mirrored = from === '/' ? '/en/' : `/en${from}`;

        assert.ok(
          lines.includes(`${mirrored} /en${to} ${status}`),
          `no English rule for ${line}`,
        );
      }

      assert.ok(lines.includes('/en /en/checkin 302'));
      assert.ok(lines.includes('/en/admin/login /en/admin 302'));
    });

    it('fits the policy in one header value', async () => {
      const policy = /Content-Security-Policy: (.*)/.exec(
        await read('_headers'),
      )?.[1];

      assert.ok(policy);
      assert.ok(policy.length <= MAX_HEADER_VALUE, String(policy.length));
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
