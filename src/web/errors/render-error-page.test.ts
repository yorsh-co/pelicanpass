import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LOCALE } from '../../i18n/locales.ts';

import { renderErrorPage } from './render-error-page.ts';

import type { Request, Response } from 'express';

interface Rendered {
  view: string;
  locals: { action?: { href: string; label: string } };
}

/** A request for `originalUrl` that accepts HTML, or JSON when `json` is set. */
const fakeReq = (originalUrl: string, json = false): Request => {
  const [path = ''] = originalUrl.split('?', 1);

  return {
    originalUrl,
    path,
    accepts: () => (json ? 'json' : 'html'),
    log: { error: () => undefined },
  } as unknown as Request;
};

/** A response recording what was rendered or sent as JSON. */
const fakeRes = () => {
  const result: { rendered?: Rendered; json?: unknown } = {};

  const res = {
    locals: { locale: BASE_LOCALE },
    status: () => res,
    render: (view: string, locals: Rendered['locals']) => {
      result.rendered = { view, locals };
    },
    json: (body: unknown) => {
      result.json = body;
    },
  } as unknown as Response;

  return { res, result };
};

/** Renders the error page for a request and returns its action href. */
const homeHref = (originalUrl: string, statusCode: number) => {
  const { res, result } = fakeRes();

  renderErrorPage(fakeReq(originalUrl), res, statusCode);

  assert.equal(result.rendered?.view, 'pages/error');

  return result.rendered.locals.action?.href;
};

describe('renderErrorPage home action', () => {
  it('links a 404 under /admin to /admin', () => {
    assert.equal(homeHref('/admin/nope', 404), '/admin');
  });

  it('links a 500 at /admin to /admin', () => {
    assert.equal(homeHref('/admin', 500), '/admin');
  });

  it('ignores the query string when matching the path', () => {
    assert.equal(homeHref('/admin/x?y=1', 404), '/admin');
    assert.equal(homeHref('/checkin?next=/admin/x', 404), '/');
  });

  it('links attendee paths to /', () => {
    assert.equal(homeHref('/checkin', 404), '/');
  });

  it('does not treat /administrator as /admin', () => {
    assert.equal(homeHref('/administrator', 404), '/');
  });

  it('offers no action on a 429 under /admin', () => {
    assert.equal(homeHref('/admin/attendees', 429), undefined);
  });
});

describe('renderErrorPage under /api', () => {
  it('answers JSON without rendering', () => {
    const { res, result } = fakeRes();

    renderErrorPage(fakeReq('/api/v1/admin/x', true), res, 404);

    assert.equal(result.rendered, undefined);
    assert.notEqual(result.json, undefined);
  });
});
