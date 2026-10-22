import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

/**
 * Guards the secret scoping of every compose file.
 *
 * Each service may hold only the variables it reads. `env_file: .env` hands a
 * service every secret the stack has, so it is refused on the services that
 * run application code (`app`, `migrate`), and every service's `environment`
 * is checked against the allow-list below. A new variable has to be added here
 * with its reason, which is the review point.
 */

const ROOT = new URL('../../', import.meta.url);

type Allowed = Record<string, string>;

/**
 * Builds an allow-list entry set sharing one reason.
 *
 * @param reason - Why these variables belong to the service.
 * @param keys - Variable names, as the container sees them.
 */
const allow = (reason: string, keys: readonly string[]): Allowed =>
  Object.fromEntries(keys.map((key) => [key, reason]));

/** What `src/config/env.ts` reads: the whole server process. */
const APP: Allowed = {
  ...allow('server config, required at boot (src/config/env.ts)', [
    'POSTGRES_HOST',
    'POSTGRES_DB',
    'REDIS_HOST',
    'APP_URL',
    'EVENT_ID',
    'TURNSTILE_SITE_KEY',
    'TURNSTILE_ADMIN_SITE_KEY',
  ]),
  POSTGRES_USER: 'application role name, the only DB identity the server uses',
  POSTGRES_PASSWORD: 'application role password',
  REDIS_PASSWORD: 'session and rate-limit store',
  PASS_SECRET: 'signs attendee pass tokens',
  ADMIN_PASSWORD_PEPPER: 'peppers administrator password hashes',
  CHECKIN_QR_TOKEN: 'venue QR token checked on every scan',
  TURNSTILE_SECRET: 'attendee captcha verification',
  TURNSTILE_ADMIN_SECRET: 'administrator sign-in captcha verification',
  LANDING_BYPASS_TOKEN: 'lets staff past the pre-event landing page',
  DISCORD_WEBHOOK_URL: 'alert delivery',
  DISCORD_WEBHOOK_URL_CRITICAL: 'critical alert delivery',
  WHATSAPP_ACCESS_TOKEN: 'WhatsApp Cloud API outbound calls',
  WHATSAPP_APP_SECRET: 'verifies inbound WhatsApp webhook signatures',
  WHATSAPP_WEBHOOK_PATH_SECRET: 'WhatsApp webhook callback path segment',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'WhatsApp webhook subscription handshake',
  ...allow('optional server tuning or feature switch (src/config/env.ts)', [
    'PORT',
    'NODE_ENV',
    'LOG_LEVEL',
    'LOG_FILE_DIR',
    'ALERT_ENABLED',
    'ALERT_DEDUP_TTL',
    'LOAD_SHED_ENABLED',
    'LOAD_SHED_MAX_LAG_MS',
    'LOAD_SHED_MAX_POOL_WAITING',
    'LOAD_SHED_RETRY_AFTER_SECONDS',
    'WHATSAPP_ENABLED',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_GRAPH_VERSION',
    'WHATSAPP_DEFAULT_COUNTRY_CODE',
    'WHATSAPP_SEND_INTERVAL_MS',
    'WHATSAPP_REQUEST_TIMEOUT',
    'WHATSAPP_MAX_ATTEMPTS',
    'WHATSAPP_DOOR_ENABLED',
    'WHATSAPP_DOOR_TEMPLATE',
    'WHATSAPP_DOOR_TEMPLATE_VOLUNTEER',
    'WHATSAPP_BUDGET_USD',
    'WHATSAPP_WEBHOOK_ENABLED',
    'TELEMETRY_EVENT_RETENTION',
    'ADMIN_URL',
    'APP_TITLE',
    'TRUSTED_IPS',
    'RATE_LIMIT_OVERRIDES',
    'PASS_BAND_ENABLED',
    'PASS_BAND_LANGUAGE',
    'PASS_WELCOME_SCHEDULE',
    'CHECKIN_SESSION_TTL',
    'ATTENDEE_SESSION_TTL',
    'ADMIN_SESSION_TTL',
    'ADMIN_SESSION_MAX_AGE',
    'POSTGRES_PORT',
    'REDIS_PORT',
    'TURNSTILE_ADMIN_ENFORCE',
    'CF_ACCESS_TEAM_DOMAIN',
    'CF_ACCESS_AUD',
    'LANDING_ENABLED',
    'EVENT_START_AT',
    'EVENT_CLOSES_AT',
    'CHECKIN_OPENS_BEFORE_PARTICIPANT',
    'CHECKIN_OPENS_BEFORE_VOLUNTEER',
    'EVENT_TIMEZONE',
    'SURVEY_PARTICIPANT_ENABLED',
    'SURVEY_VOLUNTEER_ENABLED',
    'SURVEY_OPENS_AT',
    'SURVEY_CLOSES_AT',
  ]),
};

/**
 * What `npm run migrate` and the operator CLIs run through `migrate` read.
 * None of them loads `src/config/env.ts`.
 */
const MIGRATE: Allowed = {
  ...allow('connection target for migrations and CLIs', [
    'POSTGRES_HOST',
    'POSTGRES_DB',
  ]),
  POSTGRES_MIGRATOR_USER: 'schema owner; only role allowed to DDL and admins',
  POSTGRES_MIGRATOR_PASSWORD: 'migrator role password',
  POSTGRES_USER:
    'application role name only; migrations grant privileges to it',
  POSTGRES_READONLY_USER:
    'read-only role: migration 020 grants it privileges, export-csv connects as it',
  POSTGRES_READONLY_PASSWORD:
    'read-only role password, for scripts/survey/export-csv.ts; it reads survey answers the app role cannot',
  ADMIN_PASSWORD_PEPPER:
    'create-admin and set-admin-password hash with the same pepper the app verifies against',
  EVENT_ID: 'scopes import-attendees and set-volunteer-permissions rows',
};

/** Allow-list per service name, shared by every compose file. */
const ALLOWED: Record<string, Allowed> = {
  app: APP,
  migrate: MIGRATE,
  db: {
    ...allow('image bootstrap and 01-roles.sh', ['POSTGRES_DB']),
    POSTGRES_USER: 'image bootstrap superuser (from POSTGRES_SUPERUSER)',
    POSTGRES_PASSWORD: 'bootstrap superuser password',
    APP_ROLE: 'name of the application role 01-roles.sh creates',
    APP_ROLE_PASSWORD: 'application role password',
    MIGRATOR_ROLE: 'name of the migrator role',
    MIGRATOR_ROLE_PASSWORD: 'migrator role password',
    READONLY_ROLE: 'name of the read-only role',
    READONLY_ROLE_PASSWORD: 'read-only role password',
  },
  cache: {},
  proxy: allow('Caddyfile placeholders; no secret', [
    'SITE_HOST',
    'EDGE_SUBNET',
    'VPN_IP',
    'SERVER_NAME',
  ]),
  tunnel: {
    TUNNEL_TOKEN: 'cloudflared credential; no other service may hold it',
  },
  vpn: {
    TS_AUTHKEY: 'Tailscale auth key; no other service may hold it',
    ...allow('tailscale containerboot settings, no secret', [
      'TS_STATE_DIR',
      'TS_SERVE_CONFIG',
      'TS_TAILSCALED_EXTRA_ARGS',
    ]),
  },
  k6: {
    BASE_URL: 'load-test target',
    CHECKIN_QR_TOKEN: 'door token the load test scans with',
  },
};

/**
 * Host variables that only the named services may reference, whatever name the
 * container sees them under. Catches `FOO: ${TUNNEL_TOKEN}` on the wrong
 * service, which the key allow-list alone would not.
 */
const OWNERS: readonly (readonly [RegExp, readonly string[]])[] = [
  [/^TUNNEL_TOKEN$/, ['tunnel']],
  [/^TS_AUTHKEY$/, ['vpn']],
  [/^POSTGRES_SUPERUSER(_PASSWORD)?$/, ['db']],
  [/^POSTGRES_MIGRATOR_(USER|PASSWORD)$/, ['db', 'migrate']],
  [/^POSTGRES_READONLY_(USER|PASSWORD)$/, ['db', 'migrate']],
];

/**
 * The development stack bind-mounts the whole checkout, `.env` included, so
 * scoping its environment would hide nothing.
 */
const ENV_FILE_EXEMPT = new Set(['compose.yml:app']);

interface Service {
  extends?: { file?: string; service: string };
  env_file?: unknown;
  environment?: Record<string, unknown> | string[];
}

const composeFiles = readdirSync(ROOT).filter((name) =>
  /^compose[\w.]*\.yml$/.test(name),
);

/**
 * Parses a compose file's services, resolving `extends` for `env_file`, which
 * a service inherits from the service it extends.
 *
 * @param file - File name at the repository root.
 */
const servicesOf = (file: string): Record<string, Service> => {
  const doc = parse(readFileSync(new URL(file, ROOT), 'utf8'), {
    merge: true,
  }) as { services: Record<string, Service> };

  for (const service of Object.values(doc.services)) {
    const base = service.extends;

    if (base && service.env_file === undefined) {
      const parent = base.file ? servicesOf(base.file) : doc.services;

      service.env_file = parent[base.service]?.env_file;
    }
  }

  return doc.services;
};

/**
 * The variables a service's `environment` sets, as `[name, value]` pairs.
 *
 * @param service - A parsed service.
 */
const environmentOf = (service: Service): [string, string][] => {
  const { environment } = service;

  if (environment === undefined) return [];

  if (Array.isArray(environment)) {
    return environment.map((entry) => {
      const [key = '', ...rest] = entry.split('=');

      return [key, rest.join('=')];
    });
  }

  return Object.entries(environment).map(([key, value]) => [
    key,
    String(value),
  ]);
};

describe('compose environment scoping', () => {
  it('finds the compose files', () => {
    assert.ok(composeFiles.includes('compose.prod.yml'));
    assert.ok(composeFiles.length >= 4);
  });

  for (const file of composeFiles) {
    describe(file, () => {
      for (const [name, service] of Object.entries(servicesOf(file))) {
        it(`${name} does not use env_file`, () => {
          if (ENV_FILE_EXEMPT.has(`${file}:${name}`)) return;

          assert.equal(
            service.env_file,
            undefined,
            `${file} ${name} loads a whole env file; name its variables under environment`,
          );
        });

        it(`${name} holds only variables on its allow-list`, () => {
          const allowed = ALLOWED[name];

          assert.ok(
            allowed,
            `${file}: service ${name} has no allow-list in env-scope.test.ts`,
          );

          if (ENV_FILE_EXEMPT.has(`${file}:${name}`)) return;

          const stray = environmentOf(service)
            .map(([key]) => key)
            .filter((key) => !(key in allowed));

          assert.deepEqual(stray, [], `${file} ${name}`);
        });

        it(`${name} references no other service's secret`, () => {
          const leaked: string[] = [];

          for (const [key, value] of environmentOf(service)) {
            for (const [, ref] of value.matchAll(/\$\{([A-Z_]+)/g)) {
              for (const [pattern, owners] of OWNERS) {
                if (pattern.test(ref ?? '') && !owners.includes(name)) {
                  leaked.push(`${key} <- ${ref ?? ''}`);
                }
              }
            }
          }

          assert.deepEqual(leaked, [], `${file} ${name}`);
        });
      }
    });
  }
});
