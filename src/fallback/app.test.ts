import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { after, before, describe, it } from 'node:test';

import { createFallbackApp } from './app.ts';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FallbackConfig } from './config.ts';

const HOUR = 3_600_000;

describe('fallback module graph', () => {
  // Run from an empty environment and a directory with no `.env`, so any path
  // to `config/env.ts` throws on the first secret it requires.
  it("loads without any of the live app's environment", () => {
    const entry = new URL('./app.ts', import.meta.url).href;

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(entry)});`],
      { cwd: tmpdir(), env: { PATH: process.env.PATH }, encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
  });
});

/**
 * Starts a fallback on an ephemeral port.
 *
 * @param eventStartAt - Epoch milliseconds the event starts at.
 * @param closesAt - Epoch milliseconds the event closes at, or `null`.
 */
const start = async (
  eventStartAt: number,
  closesAt: number | null = null,
): Promise<{ server: Server; base: string }> => {
  const config: FallbackConfig = {
    port: 0,
    logLevel: 'silent',
    appTitle: 'Test Event',
    eventStartAt,
    opensBefore: { participant: 0.5 * HOUR, volunteer: 4 * HOUR },
    timezone: 'America/Sao_Paulo',
    closesAt,
  };

  const server = createFallbackApp(config).listen(0);

  await new Promise<void>((resolve) => server.once('listening', resolve));

  const { port } = server.address() as AddressInfo;

  return { server, base: `http://127.0.0.1:${String(port)}` };
};

/** Reads the landing page's JSON island. */
const islandOf = (html: string): Record<string, unknown> => {
  const match = /<script id="landing-data"[^>]*>([\s\S]*?)<\/script>/.exec(
    html,
  );

  assert.ok(match?.[1], 'landing island missing');

  return JSON.parse(match[1]) as Record<string, unknown>;
};

describe('fallback before the window opens', () => {
  const eventStartAt = Date.now() + 2 * HOUR;
  let ctx: Awaited<ReturnType<typeof start>>;

  before(async () => {
    ctx = await start(eventStartAt);
  });

  after(() => {
    ctx.server.close();
  });

  it('renders the countdown, uncached, flagged as the fallback', async () => {
    const res = await fetch(`${ctx.base}/`);
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('permissions-policy') ?? '', /camera=/);
    assert.match(html, /data-landing="countdown" aria-hidden="true" >/);
    assert.match(html, /data-landing="reopening"[^>]* hidden>/);

    const island = islandOf(html);

    assert.equal(island.fallback, true);
    assert.equal(island.opensAt, eventStartAt - 0.5 * HOUR);
  });

  it('answers a check-in link in place rather than redirecting', async () => {
    const res = await fetch(`${ctx.base}/checkin?t=abc`, {
      redirect: 'manual',
    });

    assert.equal(res.status, 200);
    assert.match(await res.text(), /data-landing="countdown"/);
  });

  it('counts down to the volunteer window for volunteers', async () => {
    const res = await fetch(`${ctx.base}/?audience=volunteer`);
    const island = islandOf(await res.text());

    assert.equal(island.audience, 'volunteer');
    assert.equal(island.opensAt, eventStartAt - 4 * HOUR);
  });

  it('refuses API calls and form posts with a 503 envelope', async () => {
    for (const [path, method] of [
      ['/api/v1/attendee/pass', 'GET'],
      ['/', 'POST'],
    ] as const) {
      const res = await fetch(`${ctx.base}${path}`, { method });

      assert.equal(res.status, 503, `${method} ${path}`);
      assert.equal(res.headers.get('retry-after'), '30');
      assert.deepEqual(await res.json(), {
        success: false,
        error: 'Service temporarily unavailable',
        code: 'INTERNAL_ERROR',
      });
    }
  });

  it('serves the privacy notice and the terms, not the curtain', async () => {
    for (const path of ['/privacy', '/terms']) {
      const res = await fetch(`${ctx.base}${path}`);
      const html = await res.text();

      assert.equal(res.status, 200, path);
      assert.doesNotMatch(html, /landing-data/, path);
      assert.match(html, /<h[1-3][^>]*>/, path);
    }
  });

  it('answers the health probe', async () => {
    const res = await fetch(`${ctx.base}/healthz`);

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });
});

describe('fallback after the window opens', () => {
  let ctx: Awaited<ReturnType<typeof start>>;

  before(async () => {
    ctx = await start(Date.now());
  });

  after(() => {
    ctx.server.close();
  });

  it('draws the reopening notice in place of the countdown', async () => {
    const html = await (await fetch(`${ctx.base}/`)).text();

    assert.match(html, /data-landing="countdown" aria-hidden="true" hidden>/);
    assert.match(html, /data-landing="reopening" role="status" >/);
  });
});

describe('fallback before the event closes', () => {
  let ctx: Awaited<ReturnType<typeof start>>;

  before(async () => {
    ctx = await start(Date.now() + 2 * HOUR, Date.now() + 8 * HOUR);
  });

  after(() => {
    ctx.server.close();
  });

  it('still renders the countdown and the outage envelope', async () => {
    const page = await fetch(`${ctx.base}/`);

    assert.match(await page.text(), /data-landing="countdown"/);

    const api = await fetch(`${ctx.base}/api/v1/attendee/pass`);

    assert.equal(api.status, 503);
  });
});

describe('fallback after the event closes', () => {
  let ctx: Awaited<ReturnType<typeof start>>;

  before(async () => {
    ctx = await start(Date.now() - 8 * HOUR, Date.now() - HOUR);
  });

  after(() => {
    ctx.server.close();
  });

  it('answers every page path with the closing page, uncached', async () => {
    for (const path of ['/', '/checkin?t=abc', '/pass', '/anything']) {
      const res = await fetch(`${ctx.base}${path}`, { redirect: 'manual' });
      const html = await res.text();

      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('cache-control'), 'no-store', path);
      assert.match(html, /<h1 class="landing-title">/, path);
      assert.doesNotMatch(html, /landing-data/, path);
      assert.doesNotMatch(html, /pages\/landing\/index\.js/, path);
    }
  });

  it('refuses API calls and form posts with EVENT_CLOSED', async () => {
    for (const [path, method] of [
      ['/api/v1/attendee/pass', 'GET'],
      ['/', 'POST'],
    ] as const) {
      const res = await fetch(`${ctx.base}${path}`, { method });

      assert.equal(res.status, 410, `${method} ${path}`);
      assert.equal(res.headers.get('retry-after'), null);
      assert.deepEqual(await res.json(), {
        success: false,
        error: 'The event has closed',
        code: 'EVENT_CLOSED',
      });
    }
  });

  it('still serves the notices and the health probe', async () => {
    for (const path of ['/privacy', '/terms', '/healthz']) {
      const res = await fetch(`${ctx.base}${path}`);

      assert.equal(res.status, 200, path);
      assert.doesNotMatch(await res.text(), /landing-title/, path);
    }
  });
});

describe('fallback Content-Security-Policy', () => {
  it("has a style-src without 'unsafe-inline'", async () => {
    const { server, base } = await start(Date.now() + HOUR);

    try {
      const policy = (await fetch(`${base}/healthz`)).headers.get(
        'content-security-policy',
      );
      const styleSrc = policy
        ?.split(';')
        .find((directive) => directive.startsWith('style-src'));

      assert.ok(styleSrc, String(policy));
      assert.doesNotMatch(styleSrc, /'unsafe-inline'/);
      assert.match(styleSrc, /'nonce-[^']+'/);
    } finally {
      server.close();
    }
  });
});
