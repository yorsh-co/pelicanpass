import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

/** Variables `env.ts` requires; dependencies point at closed local ports. */
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
  LOG_LEVEL: 'silent',
};

/** Prints the Content-Security-Policy the real app serves. */
const SCRIPT = `
const { default: app } = await import(${JSON.stringify(new URL('./app.ts', import.meta.url).href)});
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const res = await fetch('http://127.0.0.1:' + server.address().port + '/healthz');
console.log(res.headers.get('content-security-policy'));
process.exit(0);
`;

describe('served Content-Security-Policy', () => {
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

  it("has a style-src without 'unsafe-inline'", () => {
    assert.equal(result.status, 0, result.stderr);

    const styleSrc = result.stdout
      .trim()
      .split(';')
      .find((directive) => directive.startsWith('style-src'));

    assert.ok(styleSrc, result.stdout);
    assert.doesNotMatch(styleSrc, /'unsafe-inline'/);
    assert.match(styleSrc, /'nonce-[^']+'/);
  });
});
