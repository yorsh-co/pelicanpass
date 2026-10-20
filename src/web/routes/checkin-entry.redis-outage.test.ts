import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

/**
 * Drives the real app, in a child process so the environment is its own, with
 * Redis never connected: every command rejects the way a stopped cache makes it
 * (`Stream isn't writeable`). The landing curtain is off by default, so
 * `/checkin` reaches the entry route.
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

/** Requests the entry route each way and prints what came back. */
const SCRIPT = `
const { default: app } = await import(${JSON.stringify(new URL('../../app.ts', import.meta.url).href)});
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const reply = async (res) => ({
  status: res.status,
  retryAfter: res.headers.get('retry-after'),
  type: res.headers.get('content-type'),
  body: await res.text(),
});
const results = {
  get: await reply(await fetch(base + '/checkin', { headers: { Accept: 'text/html' } })),
  post: await reply(await fetch(base + '/checkin', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Accept: 'text/html',
      Origin: 'https://example.test',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 't=link-token',
  })),
};
await new Promise((resolve) => setTimeout(resolve, 1000));
console.log('RESULT ' + JSON.stringify(results));
process.exit(0);
`;

const result = spawnSync(
  process.execPath,
  ['--input-type=module', '-e', SCRIPT],
  {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH, ...ENV },
    encoding: 'utf8',
    timeout: 30_000,
  },
);

interface Reply {
  status: number;
  retryAfter: string | null;
  type: string | null;
  body: string;
}

const replies = (): Record<'get' | 'post', Reply> => {
  assert.equal(result.status, 0, result.stderr);

  const line = result.stdout
    .split('\n')
    .find((entry) => entry.startsWith('RESULT '));

  assert.ok(line, result.stdout);

  return JSON.parse(line.slice('RESULT '.length)) as Record<
    'get' | 'post',
    Reply
  >;
};

describe('/checkin page with Redis unavailable', () => {
  for (const method of ['get', 'post'] as const) {
    it(`answers ${method.toUpperCase()} with the 503 page and Retry-After`, () => {
      const reply = replies()[method];

      assert.equal(reply.status, 503);
      assert.match(reply.retryAfter ?? '', /^[1-9]\d*$/);
      assert.match(reply.type ?? '', /text\/html/);
      assert.match(reply.body, /Aguarde alguns segundos/);
    });
  }

  it('logs no error-level line for it', () => {
    replies();

    const errors = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { level: number; msg?: string })
      .filter((entry) => entry.level >= 50 && entry.msg !== 'Redis error');

    assert.deepEqual(errors, []);
  });
});
