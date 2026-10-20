import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

/**
 * Drives the real app, in a child process so the environment is its own, with
 * Redis never connected: every command rejects the way a stopped cache makes
 * it (`Stream isn't writeable`). Requests carry attendee and admin session
 * cookies, so each one has a session to look up, which is the Redis work an
 * attendee does on every page and call.
 */

const ENV = {
  APP_URL: 'https://example.test',
  EVENT_ID: 'event',
  CHECKIN_QR_TOKEN: 'a1b2c3d4e5f6a7b8c9d0',
  PASS_SECRET: 'a'.repeat(64),
  ADMIN_PASSWORD_PEPPER: 'b'.repeat(64),
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_PORT: '1',
  POSTGRES_DB: 'db',
  POSTGRES_USER: 'app',
  POSTGRES_PASSWORD: 'password1234',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '1',
  REDIS_PASSWORD: 'password1234',
  TURNSTILE_SITE_KEY: 'site',
  TURNSTILE_SECRET: 'secret',
  TURNSTILE_ADMIN_SITE_KEY: 'site',
  TURNSTILE_ADMIN_SECRET: 'secret',
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
};

/** One request to make: method, path and an optional JSON body. */
type Probe = readonly [method: string, path: string, body?: string];

interface Reply {
  status: number;
  retryAfter: string | null;
  location: string | null;
  type: string | null;
  body: string;
}

interface Run {
  replies: Record<string, Reply>;
  logs: { level: number; msg?: string }[];
}

/** Pages the attendee and volunteers open, and the calls those pages make. */
const PAGES: Probe[] = [
  ['GET', '/'],
  ['GET', '/pass'],
  ['GET', '/staff'],
  ['GET', '/raffle'],
];

const CALLS: Probe[] = [
  ['GET', '/api/v1/attendee/pass'],
  ['GET', '/api/v1/attendee/status'],
  ['POST', '/api/v1/attendee/logout', '{}'],
  ['POST', '/api/v1/survey', '{}'],
  ['POST', '/api/v1/staff/verify', '{}'],
  ['POST', '/api/v1/staff/redeem', '{}'],
  ['POST', '/api/v1/staff/lookup', '{}'],
  ['GET', '/api/v1/raffle/draws'],
  ['POST', '/api/v1/raffle/draw', '{}'],
];

/** Surfaces that must behave as they do today. */
const UNCHANGED: Probe[] = [
  ['GET', '/healthz'],
  ['GET', '/admin/login'],
  ['GET', '/admin'],
  ['GET', '/api/v1/admin/attendees'],
  ['GET', '/api/v1/admin/metrics/summary'],
];

/**
 * Runs the app and makes each request with both session cookies.
 *
 * @param probes - Requests to make.
 */
const run = (probes: readonly Probe[]): Run => {
  const script = `
const { default: app } = await import(${JSON.stringify(new URL('./app.ts', import.meta.url).href)});
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const id = '3f2b8c1e-9d4a-4b7e-8a61-2c5d7e9f0a1b';
const replies = {};
for (const [method, path, body] of ${JSON.stringify(probes)}) {
  const api = path.startsWith('/api');
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    body,
    headers: {
      cookie: 'attendee_session_id=' + id + '; admin_session_id=' + id,
      Accept: api ? 'application/json' : 'text/html',
      Origin: 'https://example.test',
      'X-Admin-Gate': 'tailnet',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  replies[method + ' ' + path] = {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    location: res.headers.get('location'),
    type: res.headers.get('content-type'),
    body: await res.text(),
  };
}
await new Promise((resolve) => setTimeout(resolve, 1000));
console.log('RESULT ' + JSON.stringify(replies));
process.exit(0);
`;

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH, ...ENV },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );

  assert.equal(result.status, 0, result.stderr);

  const lines = result.stdout.split('\n');
  const line = lines.find((entry) => entry.startsWith('RESULT '));

  assert.ok(line, result.stdout);

  return {
    replies: JSON.parse(line.slice('RESULT '.length)) as Record<string, Reply>,
    logs: lines
      .filter((entry) => entry.startsWith('{'))
      .map((entry) => JSON.parse(entry) as { level: number; msg?: string }),
  };
};

describe('attendee surfaces with Redis unavailable', () => {
  const attendee = run([...PAGES, ...CALLS]);

  for (const [method, path] of PAGES) {
    it(`answers ${method} ${path} with the 503 page and Retry-After`, () => {
      const reply = attendee.replies[`${method} ${path}`];

      assert.equal(reply?.status, 503);
      assert.match(reply.retryAfter ?? '', /^[1-9]\d*$/);
      assert.match(reply.type ?? '', /text\/html/);
      assert.match(reply.body, /Aguarde alguns segundos/);
    });
  }

  for (const [method, path] of CALLS) {
    it(`answers ${method} ${path} 503 in the API error shape`, () => {
      const reply = attendee.replies[`${method} ${path}`];

      assert.equal(reply?.status, 503);
      assert.match(reply.retryAfter ?? '', /^[1-9]\d*$/);

      assert.deepEqual(JSON.parse(reply.body), {
        success: false,
        error: 'Service temporarily unavailable',
        code: 'SERVICE_UNAVAILABLE',
        details: { retryAfterSeconds: Number(reply.retryAfter) },
      });
    });
  }

  it('logs nothing at error for them', () => {
    const errors = attendee.logs.filter(
      (entry) => entry.level >= 50 && entry.msg !== 'Redis error',
    );

    assert.deepEqual(errors, []);
  });
});

describe('admin and probe paths with Redis unavailable', () => {
  const other = run(UNCHANGED);

  it('keep the answers they gave before', () => {
    const answers = Object.fromEntries(
      Object.entries(other.replies).map(([key, reply]) => [
        key,
        [reply.status, reply.location],
      ]),
    );

    assert.deepEqual(answers, {
      'GET /healthz': [200, null],
      'GET /admin/login': [200, null],
      'GET /admin': [302, '/admin/login'],
      'GET /api/v1/admin/attendees': [401, null],
      'GET /api/v1/admin/metrics/summary': [401, null],
    });
  });
});
