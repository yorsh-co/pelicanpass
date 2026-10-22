import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';

import cookieParser from 'cookie-parser';
import express from 'express';

import { localeMiddleware, resolveLocale } from './server.ts';

import type { LocaleLink } from './server.ts';
import type { Request } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let port: number;

before(async () => {
  const app = express();

  app.use(cookieParser());
  app.use(localeMiddleware);
  app.get('/locale-links', (_req, res) => {
    res.json(res.locals.localeLinks);
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
});

/**
 * Sends a GET with the path exactly as given, which `fetch` would normalise.
 *
 * @param path - The raw request target.
 * @returns The status and `Location` header.
 */
const get = (
  path: string,
): Promise<{ status: number; location: string | undefined }> =>
  new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, location: res.headers.location });
    })
      .on('error', reject)
      .end();
  });

describe('localeMiddleware ?lang= redirect', () => {
  it('answers a path-only Location for a doubled leading slash', async () => {
    const { status, location } = await get(
      '//evil.example//attacker.example/x?lang=pt-BR',
    );

    assert.equal(status, 303);
    assert.match(location ?? '', /^\/(?![/\\])/);
  });

  it('keeps a normal path and its other parameters', async () => {
    const { location } = await get('/checkin?lang=pt-BR&audience=volunteer');

    assert.equal(location, '/checkin?audience=volunteer');
  });
});

describe('resolveLocale Accept-Language', () => {
  const resolve = (...tags: string[]) =>
    resolveLocale({
      cookies: {},
      acceptsLanguages: () => tags,
    } as unknown as Request);

  it('selects en for an English browser', () => {
    assert.equal(resolve('en-US', 'en'), 'en');
  });

  it('selects pt-BR for a Portuguese browser', () => {
    assert.equal(resolve('pt-BR', 'pt'), 'pt-BR');
  });

  it('falls back to pt-BR for an unoffered language', () => {
    assert.equal(resolve('fr-FR'), 'pt-BR');
  });
});

describe('localeMiddleware switcher codes', () => {
  it("labels each locale with its tag's region, or its language", async () => {
    const links = await new Promise<LocaleLink[]>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/locale-links' }, (res) => {
        let body = '';

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve(JSON.parse(body) as LocaleLink[]);
        });
      })
        .on('error', reject)
        .end();
    });
    const codes = Object.fromEntries(
      links.map(({ locale, code }) => [locale, code]),
    );

    assert.equal(codes['pt-BR'], 'BR');
    assert.equal(codes.en, 'EN');
    assert.ok(codes['en-XA'] === undefined || codes['en-XA'] === 'XA');
  });
});
