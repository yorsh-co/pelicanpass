import { devNull } from 'node:os';

/**
 * Preload for `npm test` (`node --import`): gives the suite a valid, fixed
 * environment so it does not depend on the developer's `.env`.
 *
 * `src/config/env.ts` validates as it loads, and many test files import it at
 * load time. Without this module they fail on a missing `.env` (required
 * variables unset), on the weak placeholders in `.env.example` (rejected under
 * `NODE_ENV=production`), and on `PASS_SECRET` not being hexadecimal.
 *
 * No `.env` is loaded at all: `dotenv/config` is pointed at the null device,
 * because any value it supplied (an app title, a time zone) would leak into
 * rendered output and fail the view snapshots on one machine but not another.
 * A variable exported in the shell still wins over the placeholders below,
 * which pass validation and are not credentials. Tests that spawn a child run
 * it from the temp directory with an explicit `env`, so it loads no `.env`
 * either.
 */
process.env.DOTENV_CONFIG_PATH = devNull;

const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  APP_URL: 'https://example.test',
  EVENT_ID: 'event',
  CHECKIN_QR_TOKEN: 'a1b2c3d4e5f6a7b8c9d0',
  PASS_SECRET: '0'.repeat(64),
  ADMIN_PASSWORD_PEPPER: '1'.repeat(64),
  POSTGRES_HOST: 'db',
  POSTGRES_DB: 'db',
  POSTGRES_USER: 'app',
  POSTGRES_PASSWORD: 'test-only-password',
  REDIS_HOST: 'cache',
  REDIS_PASSWORD: 'test-only-password',
  TURNSTILE_SITE_KEY: 'test-site-key',
  TURNSTILE_SECRET: 'test-secret',
  TURNSTILE_ADMIN_SITE_KEY: 'test-site-key',
  TURNSTILE_ADMIN_SECRET: 'test-secret',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
