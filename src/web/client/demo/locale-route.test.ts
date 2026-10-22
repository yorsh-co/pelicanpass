import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  inTree,
  isDemoLocale,
  localizedPath,
  routeLocale,
  stripTree,
  treeOf,
  urlInTree,
} from './locale-route.ts';

import type { LocaleRoute, LocaleRouteInput } from './locale-route.ts';

/** Routes a visit, with no query, hash or saved choice unless given. */
const route = (
  pathname: string,
  rest: Partial<LocaleRouteInput> = {},
): LocaleRoute =>
  routeLocale({
    pathname,
    search: '',
    hash: '',
    stored: null,
    browser: 'en-US',
    ...rest,
  });

describe('trees', () => {
  it('tells the English tree from pt-BR by whole path segment', () => {
    assert.equal(treeOf('/en'), 'en');
    assert.equal(treeOf('/en/'), 'en');
    assert.equal(treeOf('/en/admin/metrics'), 'en');
    assert.equal(treeOf('/'), 'pt-BR');
    assert.equal(treeOf('/checkin'), 'pt-BR');
    assert.equal(treeOf('/english'), 'pt-BR');
    assert.equal(treeOf('/admin/en'), 'pt-BR');
  });

  it('strips the English prefix and keeps the rest', () => {
    assert.equal(stripTree('/en/pass'), '/pass');
    assert.equal(stripTree('/en/'), '/');
    assert.equal(stripTree('/en'), '/');
    assert.equal(stripTree('/pass'), '/pass');
    assert.equal(stripTree('/'), '/');
  });

  it('moves a path between trees in both directions', () => {
    assert.equal(inTree('/checkin', 'en'), '/en/checkin');
    assert.equal(inTree('/', 'en'), '/en/');
    assert.equal(inTree('/en/checkin', 'en'), '/en/checkin');
    assert.equal(inTree('/en/admin/metrics', 'pt-BR'), '/admin/metrics');
    assert.equal(inTree('/en/', 'pt-BR'), '/');
    assert.equal(inTree('/en', 'pt-BR'), '/');
    assert.equal(inTree('/checkin', 'pt-BR'), '/checkin');
  });

  it('never yields a protocol-relative path', () => {
    assert.equal(inTree('/en//evil.example/x', 'pt-BR'), '/evil.example/x');
    assert.equal(stripTree('/en//evil.example'), '/evil.example');
    assert.equal(inTree('//evil.example', 'pt-BR'), '/evil.example');
    assert.equal(
      route('/en//evil.example/x', { stored: 'pt-BR' }).url,
      '/evil.example/x',
    );
  });

  it('puts a path in the tree the page is in', () => {
    assert.equal(localizedPath('/en/checkin', '/pass'), '/en/pass');
    assert.equal(localizedPath('/checkin', '/pass'), '/pass');
    assert.equal(localizedPath('/en/', '/admin'), '/en/admin');
  });

  it('moves root-absolute URLs, with query and hash, and leaves the rest', () => {
    assert.equal(urlInTree('/checkin', 'en'), '/en/checkin');
    assert.equal(urlInTree('/pass?a=1#b', 'en'), '/en/pass?a=1#b');
    assert.equal(urlInTree('/en/pass', 'en'), '/en/pass');
    assert.equal(urlInTree('/', 'en'), '/en/');
    assert.equal(urlInTree('/pass', 'pt-BR'), '/pass');
    assert.equal(urlInTree('pass', 'en'), 'pass');
    assert.equal(urlInTree('?a=1', 'en'), '?a=1');
    assert.equal(urlInTree('//evil.example/x', 'en'), '//evil.example/x');
    assert.equal(urlInTree('https://a.example/x', 'en'), 'https://a.example/x');
  });

  it('recognises only the offered locales', () => {
    assert.ok(isDemoLocale('pt-BR'));
    assert.ok(isDemoLocale('en'));
    assert.equal(isDemoLocale('en-XA'), false);
    assert.equal(isDemoLocale('pt'), false);
    assert.equal(isDemoLocale(null), false);
  });
});

describe('routeLocale without a choice in the URL', () => {
  it('leaves a page already in the right tree alone', () => {
    assert.deepEqual(route('/en/checkin', { stored: 'en' }), {
      locale: 'en',
      save: null,
      url: null,
      redirect: false,
    });
    assert.equal(route('/checkin', { stored: 'pt-BR' }).url, null);
  });

  it('lets a saved choice win over the browser language', () => {
    assert.equal(
      route('/checkin', { stored: 'en', browser: 'pt-BR' }).locale,
      'en',
    );
    assert.equal(route('/en/checkin', { stored: 'pt-BR' }).locale, 'pt-BR');
  });

  it('sends a first visit by browser language: pt to pt-BR, the rest to English', () => {
    assert.equal(route('/checkin', { browser: 'pt-BR' }).url, null);
    assert.equal(route('/checkin', { browser: 'PT' }).url, null);
    assert.equal(route('/checkin', { browser: 'pt-PT' }).url, null);
    assert.equal(route('/checkin', { browser: 'en-US' }).url, '/en/checkin');
    assert.equal(route('/checkin', { browser: 'fr' }).url, '/en/checkin');
    assert.equal(route('/en/checkin', { browser: 'pt-BR' }).url, '/checkin');
  });

  it('treats a browser with no language as Portuguese, as the app does', () => {
    assert.equal(route('/checkin', { browser: undefined }).url, null);
    assert.equal(route('/checkin', { browser: '' }).url, null);
    assert.equal(route('/en/checkin', { browser: '' }).url, '/checkin');
  });

  it('ignores a saved value that is not a demo locale', () => {
    assert.equal(
      route('/checkin', { stored: 'de', browser: 'en-US' }).url,
      '/en/checkin',
    );
    assert.equal(
      route('/checkin', { stored: 'en-XA', browser: 'pt' }).url,
      null,
    );
    assert.equal(route('/checkin', { stored: '', browser: 'pt' }).url, null);
  });

  it('keeps the query and hash across trees, byte for byte', () => {
    const search = '?audience=volunteer&t=a%20b+c';

    assert.deepEqual(
      route('/checkin', { search, hash: '#top', stored: 'en' }),
      {
        locale: 'en',
        save: null,
        url: `/en/checkin${search}#top`,
        redirect: true,
      },
    );
    assert.equal(
      route('/en/admin/metrics', { search, stored: 'pt-BR' }).url,
      `/admin/metrics${search}`,
    );
  });

  it('maps the roots to each other, which _redirects then send to check-in', () => {
    assert.equal(route('/', { stored: 'en' }).url, '/en/');
    assert.equal(route('/en/', { stored: 'pt-BR' }).url, '/');
    assert.equal(route('/en', { stored: 'pt-BR' }).url, '/');
  });

  it('catches a root-absolute navigation of the app, such as check-in to the pass', () => {
    assert.deepEqual(route('/pass', { stored: 'en' }), {
      locale: 'en',
      save: null,
      url: '/en/pass',
      redirect: true,
    });
  });

  it('does not touch an unsupported lang parameter', () => {
    const result = route('/checkin', { search: '?lang=fr', stored: 'pt-BR' });

    assert.equal(result.save, null);
    assert.equal(result.url, null);
  });
});

describe('routeLocale with ?lang=', () => {
  it('saves the choice and drops the parameter in place when already right', () => {
    assert.deepEqual(
      route('/en/checkin', { search: '?lang=en', stored: 'pt-BR' }),
      { locale: 'en', save: 'en', url: '/en/checkin', redirect: false },
    );
    assert.deepEqual(
      route('/checkin', { search: '?lang=pt-BR', browser: 'en-US' }),
      { locale: 'pt-BR', save: 'pt-BR', url: '/checkin', redirect: false },
    );
  });

  it('beats the saved choice and the browser language', () => {
    const result = route('/checkin', {
      search: '?lang=en',
      stored: 'pt-BR',
      browser: 'pt-BR',
    });

    assert.equal(result.locale, 'en');
    assert.equal(result.save, 'en');
  });

  it('redirects to the other tree without the parameter', () => {
    assert.deepEqual(route('/checkin', { search: '?lang=en' }), {
      locale: 'en',
      save: 'en',
      url: '/en/checkin',
      redirect: true,
    });
    assert.deepEqual(
      route('/en/admin/metrics', { search: '?lang=pt-BR', hash: '#a' }),
      {
        locale: 'pt-BR',
        save: 'pt-BR',
        url: '/admin/metrics#a',
        redirect: true,
      },
    );
  });

  it('keeps the other parameters and drops every lang', () => {
    assert.equal(
      route('/checkin', { search: '?a=1&lang=en&b=2' }).url,
      '/en/checkin?a=1&b=2',
    );
    assert.equal(
      route('/en/pass', { search: '?lang=en&lang=en', stored: 'en' }).url,
      '/en/pass',
    );
  });

  it('settles on the target in one step, whatever the storage', () => {
    for (const stored of [null, 'pt-BR', 'en']) {
      const first = route('/checkin', { search: '?lang=en', stored });
      const [path = '', search = ''] = (first.url ?? '').split('?');
      const second = route(path, {
        search: search === '' ? '' : `?${search}`,
        stored: first.save,
      });

      assert.equal(second.url, null, `stored ${String(stored)}`);
    }
  });
});

describe('routeLocale with storage blocked', () => {
  it('falls back to the browser language and does not bounce between trees', () => {
    const blocked = { stored: null, browser: 'pt-BR' } as const;
    const first = route('/en/checkin', blocked);

    assert.equal(first.url, '/checkin');

    const second = route('/checkin', blocked);

    assert.equal(second.url, null);
  });
});
