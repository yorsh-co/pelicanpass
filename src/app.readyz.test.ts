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

/** Requests every case against the real app and prints `[label, status]` pairs. */
const SCRIPT = `
const { default: app } = await import(${JSON.stringify(new URL('./app.ts', import.meta.url).href)});
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const results = {};
for (const path of ['/readyz', '/readyz/']) {
  for (const gate of [undefined, 'tailnet', 'TAILNET']) {
    const res = await fetch(base + path, {
      headers: gate === undefined ? {} : { 'X-Admin-Gate': gate },
    });
    results[path + ' ' + String(gate)] = res.status;
  }
}
console.log(JSON.stringify(results));
process.exit(0);
`;

describe('/readyz gate', () => {
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
  const statuses = (): Record<string, number> => {
    assert.equal(result.status, 0, result.stderr);

    return JSON.parse(result.stdout) as Record<string, number>;
  };

  for (const path of ['/readyz', '/readyz/']) {
    it(`answers 404 for ${path} without the tailnet header`, () => {
      assert.equal(statuses()[`${path} undefined`], 404);
    });

    it(`answers 404 for ${path} with a different header value`, () => {
      assert.equal(statuses()[`${path} TAILNET`], 404);
    });

    it(`serves ${path} with the tailnet header`, () => {
      // Dependencies are unreachable here, so the probe reports 503, not 200.
      assert.equal(statuses()[`${path} tailnet`], 503);
    });
  }
});
