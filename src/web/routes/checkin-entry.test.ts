import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import { getMessages } from '../../i18n/server.ts';
import { env } from '../../config/env.ts';
import { requireSameOrigin } from '../../middleware/same-origin.middleware.ts';
import { AppError } from '../../shared/errors/app-error.ts';
import { checkinEntry, checkinEntryPost } from './checkin-entry.ts';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CheckinEntryService } from './checkin-entry.ts';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const TOKEN = 'link-token-of-the-attacker';

let server: Server;
let port: number;
let initCalls: unknown[];

/** Stands in for the real service: records the call and mints a session cookie. */
const createService = (res: express.Response): CheckinEntryService =>
  ({
    init: (options: unknown) => {
      initCalls.push(options);
      res.cookie('checkin_session_id', 'minted', { httpOnly: true });

      return Promise.resolve({
        success: true,
        data: { session: { attendeePreview: { name: 'Ana A.' } } },
      });
    },
  }) as unknown as CheckinEntryService;

before(async () => {
  const app = express();

  app.use((req, res, next) => {
    Object.assign(req, { log: { warn: () => undefined } });
    res.locals.locale = 'pt-BR';
    res.locals.chrome = getMessages('pt-BR', 'chrome');
    // Echoes what the route would render, so a test reads the view and locals.
    res.render = (view: string, locals: unknown) => {
      res.status(200).json({ view, locals });
    };

    next();
  });
  app.get(
    '/checkin',
    checkinEntry((_req, res) => createService(res)),
  );
  app.post(
    '/checkin',
    requireSameOrigin,
    express.urlencoded({ extended: false }),
    checkinEntryPost((_req, res) => createService(res)),
  );
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err instanceof AppError ? err.statusCode : 500).end();
    },
  );

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

beforeEach(() => {
  initCalls = [];
});

after(() => {
  server.close();
});

const send = (
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string> = {},
  payload?: string,
) =>
  new Promise<Reply>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
        }),
      );
    })
      .on('error', reject)
      .end(payload);
  });

const get = (path: string, headers: Record<string, string> = {}) =>
  send('GET', path, headers);

const post = (fields: string, headers: Record<string, string> = {}) =>
  send(
    'POST',
    '/checkin',
    { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    fields,
  );

const setsSession = (reply: Reply): boolean =>
  String(reply.headers['set-cookie'] ?? '').includes('checkin_session_id');

describe('GET /checkin entry', () => {
  for (const param of ['t', 'k']) {
    it(`writes no session for a cross-site ?${param}= and asks to continue`, async () => {
      const reply = await get(`/checkin?${param}=${TOKEN}&audience=volunteer`, {
        'sec-fetch-site': 'cross-site',
      });

      assert.equal(reply.status, 200);
      assert.equal(setsSession(reply), false);
      assert.deepEqual(initCalls, []);

      const { view, locals } = JSON.parse(reply.body) as {
        view: string;
        locals: Record<string, unknown>;
      };

      assert.equal(view, 'pages/attendee/checkin/continue');
      assert.equal(reply.body.includes('Ana A.'), false);
      assert.equal('initialData' in locals, false);
    });
  }

  for (const site of ['none', 'same-origin', 'same-site', undefined]) {
    it(`keeps the redirect and the cookie when Sec-Fetch-Site is ${site ?? 'absent'}`, async () => {
      const reply = await get(
        `/checkin?t=${TOKEN}&audience=volunteer`,
        site === undefined ? {} : { 'sec-fetch-site': site },
      );

      assert.equal(reply.status, 303);
      assert.equal(reply.headers.location, '/checkin?audience=volunteer');
      assert.equal(setsSession(reply), true);
      assert.equal(initCalls.length, 1);
    });
  }

  it('keeps rendering the page for a cross-site request with no token', async () => {
    const reply = await get('/checkin', { 'sec-fetch-site': 'cross-site' });

    assert.equal(reply.status, 200);
    assert.equal(
      (JSON.parse(reply.body) as { view: string }).view,
      'pages/attendee/checkin/checkin',
    );
    assert.equal(initCalls.length, 1);
  });
});

describe('POST /checkin entry', () => {
  const origin = new URL(env.appUrl).origin;

  it('completes the entry from this origin and drops the token', async () => {
    const reply = await post(`t=${TOKEN}&audience=volunteer`, {
      origin,
      'sec-fetch-site': 'same-origin',
    });

    assert.equal(reply.status, 303);
    assert.equal(reply.headers.location, '/checkin?audience=volunteer');
    assert.equal(setsSession(reply), true);
    assert.deepEqual(initCalls, [{ qrToken: undefined, linkToken: TOKEN }]);
  });

  it('completes a QR token entry the same way', async () => {
    const reply = await post(`k=${TOKEN}`, { origin });

    assert.equal(reply.status, 303);
    assert.equal(reply.headers.location, '/checkin');
    assert.deepEqual(initCalls, [{ qrToken: TOKEN, linkToken: undefined }]);
  });

  it('refuses a post from another site and writes nothing', async () => {
    const reply = await post(`t=${TOKEN}`, {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });

    assert.equal(reply.status, 403);
    assert.equal(setsSession(reply), false);
    assert.deepEqual(initCalls, []);
  });

  it('starts nothing when the form carries no token', async () => {
    const reply = await post('audience=volunteer', { origin });

    assert.equal(reply.status, 303);
    assert.equal(reply.headers.location, '/checkin?audience=volunteer');
    assert.deepEqual(initCalls, []);
  });
});
