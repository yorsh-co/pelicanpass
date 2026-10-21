import { devNull } from 'node:os';

/**
 * Fixed environment for the demo build, applied on import.
 *
 * `src/config/env.ts` validates as it loads, and the view fixtures import it
 * for the app title and time zone. Nothing here is a credential and none of it
 * reaches the output: the pages read the title and time zone only.
 *
 * `NODE_ENV` is production so the pages render as the deployed app does, with
 * no pseudo-locale in the language switcher and no development markers. That
 * is why the passwords below are long and unremarkable, as production
 * validation requires.
 *
 * Import this module before anything that imports `config/env.ts`.
 */
process.env.DOTENV_CONFIG_PATH = devNull;

const PLACEHOLDER = 'demo-build-placeholder-not-a-credential';

Object.assign(process.env, {
  NODE_ENV: 'production',
  APP_URL: 'https://pelicanpass.demos.yorsh.co',
  EVENT_ID: 'demo',
  CHECKIN_QR_TOKEN: 'a1b2c3d4e5f6a7b8c9d0',
  PASS_SECRET: '0'.repeat(64),
  ADMIN_PASSWORD_PEPPER: '1'.repeat(64),
  POSTGRES_HOST: 'db',
  POSTGRES_DB: 'db',
  POSTGRES_USER: 'app',
  POSTGRES_PASSWORD: PLACEHOLDER,
  REDIS_HOST: 'cache',
  REDIS_PASSWORD: PLACEHOLDER,
  TURNSTILE_SITE_KEY: PLACEHOLDER,
  TURNSTILE_SECRET: PLACEHOLDER,
  TURNSTILE_ADMIN_SITE_KEY: PLACEHOLDER,
  TURNSTILE_ADMIN_SECRET: PLACEHOLDER,
});
