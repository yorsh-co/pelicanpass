import { existsSync, readFileSync } from 'node:fs';

import 'dotenv/config';

import { MIN_PASSWORD_LENGTH, WEAK_PASSWORDS } from '../constants/password.ts';
import { QR_TOKEN_PATTERN } from '../constants/qr-token.ts';
import {
  boolean,
  duration,
  numeric,
  optional,
  read,
  required,
  timestamp,
} from './read-env.ts';
import {
  readEventClosesAt,
  readEventTimezone,
  readOpensBefore,
} from './event-window.ts';
import { parseWelcomeSchedule } from './pass-welcome.ts';

/**
 * Reads the release the production image was built from.
 *
 * The Dockerfile's `release` stage writes `git describe` output to `RELEASE`
 * at the app root. It is validated before use because it reaches HTML, logs
 * and alerts verbatim.
 *
 * @returns The release, `dev` when no file exists (the development stack and
 *   local runs), or `unknown` when its content is malformed.
 */
function readRelease(): string {
  const file = new URL('../../RELEASE', import.meta.url);

  if (!existsSync(file)) return 'dev';

  const release = readFileSync(file, 'utf8').trim();

  return /^[\w.+-]+$/.test(release) ? release : 'unknown';
}

export { MIN_PASSWORD_LENGTH, WEAK_PASSWORDS };

/**
 * Validates that a password-type environment variable is not a known-weak
 * or default value, and meets a minimum length. Only enforced in production
 * so local development can keep using simple passwords.
 *
 * @param key - Name of the environment variable (for error messages).
 * @param value - The password value to validate.
 * @throws {Error} If the password is too short or a known-weak value.
 */
function validatePasswordSecurity(key: string, value: string): void {
  if (process.env.NODE_ENV !== 'production') return;

  if (WEAK_PASSWORDS.has(value.toLowerCase())) {
    throw new Error(
      `Environment variable ${key} is set to a known-weak default value`,
    );
  }

  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Environment variable ${key} must be at least ${String(MIN_PASSWORD_LENGTH)} characters`,
    );
  }
}

const HEX_SECRET_MIN_LENGTH = 64;

const HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Validates the shape of a long-lived cryptographic secret.
 *
 * Enforced in every environment, unlike {@link validatePasswordSecurity}. A
 * simple database password in development is a deliberate convenience; a short
 * key is not the same thing, because it means development is not exercising the
 * primitive the event will run on. `openssl rand -hex 32` costs the same
 * locally as it does in production.
 *
 * @param key - Name of the environment variable (for error messages).
 * @param value - The secret to validate.
 * @throws {Error} If the secret is not hexadecimal or is too short.
 */
function validateHexSecret(key: string, value: string): void {
  if (!HEX_RE.test(value)) {
    throw new Error(
      `Environment variable ${key} must be hexadecimal, as produced by \`openssl rand -hex 32\``,
    );
  }

  if (value.length < HEX_SECRET_MIN_LENGTH) {
    throw new Error(
      `Environment variable ${key} must be at least ${String(HEX_SECRET_MIN_LENGTH)} characters`,
    );
  }
}

/**
 * Refuses a half-configured integration at boot.
 *
 * The credentials below are read with {@link optional} so that an unconfigured
 * deployment still boots, which is the right default for a laptop and for event
 * night. That leniency has a cost: a feature switched on with a missing key
 * would boot cleanly and fail at its first real use, which for the webhook
 * means a silent `403` back to Meta and receipts that quietly never arrive.
 *
 * Every missing key is named at once rather than the first, because the
 * alternative is one restart per variable.
 *
 * @param flag - Name of the switch that made these keys mandatory.
 * @param enabled - Whether that switch is on.
 * @param keys - Names of the variables the switch requires.
 * @throws {Error} If the switch is on and any of the keys is unset or empty.
 */
function requireWhenEnabled(
  flag: string,
  enabled: boolean,
  keys: string[],
): void {
  if (!enabled) return;

  const missing = keys.filter((key) => read(key) === undefined);

  if (missing.length > 0) {
    throw new Error(
      `${flag} is true, so ${missing.join(', ')} must be set (or set ${flag}=false)`,
    );
  }
}

const landingEnabled = boolean('LANDING_ENABLED', false);

const surveyEnabled = {
  participant: boolean('SURVEY_PARTICIPANT_ENABLED', false),
  volunteer: boolean('SURVEY_VOLUNTEER_ENABLED', false),
};

const whatsappEnabled = boolean('WHATSAPP_ENABLED', false);
const whatsappWebhookEnabled = boolean('WHATSAPP_WEBHOOK_ENABLED', false);

requireWhenEnabled('WHATSAPP_ENABLED', whatsappEnabled, [
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_ACCESS_TOKEN',
]);

const whatsappDoorEnabled = boolean('WHATSAPP_DOOR_ENABLED', false);

// Presence only. Whether each template key names a registry entry is checked as
// admin.whatsapp-door.service.ts loads, the way survey.window.ts checks its
// question files: this module reads the environment and imports nothing of the
// domain.
requireWhenEnabled('WHATSAPP_DOOR_ENABLED', whatsappDoorEnabled, [
  'WHATSAPP_DOOR_TEMPLATE',
  'WHATSAPP_DOOR_TEMPLATE_VOLUNTEER',
  'WHATSAPP_BUDGET_USD',
]);

// Presence only, deliberately: `validateHexSecret` would reject Meta's app
// secret, which is 32 hex characters against that helper's 64-character floor,
// and the verify token is documented as any high-entropy string rather than a
// hex one. Shape validation here would refuse correct values.
requireWhenEnabled('WHATSAPP_WEBHOOK_ENABLED', whatsappWebhookEnabled, [
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_WEBHOOK_PATH_SECRET',
]);

requireWhenEnabled('SURVEY_PARTICIPANT_ENABLED', surveyEnabled.participant, [
  'SURVEY_OPENS_AT',
]);
requireWhenEnabled('SURVEY_VOLUNTEER_ENABLED', surveyEnabled.volunteer, [
  'SURVEY_OPENS_AT',
]);

const surveyOn = surveyEnabled.participant || surveyEnabled.volunteer;
const surveyOpensAt = surveyOn ? timestamp('SURVEY_OPENS_AT') : null;
const surveyClosesAt =
  surveyOn && read('SURVEY_CLOSES_AT') !== undefined
    ? timestamp('SURVEY_CLOSES_AT')
    : null;

if (
  surveyOpensAt !== null &&
  surveyClosesAt !== null &&
  surveyClosesAt <= surveyOpensAt
) {
  throw new Error(
    `SURVEY_CLOSES_AT (${new Date(surveyClosesAt).toISOString()}) must be after SURVEY_OPENS_AT (${new Date(surveyOpensAt).toISOString()})`,
  );
}

const eventStartAt = landingEnabled ? timestamp('EVENT_START_AT') : null;
const eventClosesAt = readEventClosesAt();

// The closing page replaces the pass, and the pass is where the questionnaire
// is answered: closing first would hide a form that is still open.
if (
  eventClosesAt !== null &&
  surveyClosesAt !== null &&
  eventClosesAt < surveyClosesAt
) {
  throw new Error(
    `EVENT_CLOSES_AT (${new Date(eventClosesAt).toISOString()}) must not be before SURVEY_CLOSES_AT (${new Date(surveyClosesAt).toISOString()})`,
  );
}

if (
  eventClosesAt !== null &&
  eventStartAt !== null &&
  eventClosesAt <= eventStartAt
) {
  throw new Error(
    `EVENT_CLOSES_AT (${new Date(eventClosesAt).toISOString()}) must be after EVENT_START_AT (${new Date(eventStartAt).toISOString()})`,
  );
}

validatePasswordSecurity('POSTGRES_PASSWORD', required('POSTGRES_PASSWORD'));
validatePasswordSecurity('REDIS_PASSWORD', required('REDIS_PASSWORD'));

const passSecret = required('PASS_SECRET');
const adminPasswordPepper = required('ADMIN_PASSWORD_PEPPER');

validateHexSecret('PASS_SECRET', passSecret);
validateHexSecret('ADMIN_PASSWORD_PEPPER', adminPasswordPepper);

/**
 * The check-in route applies the same pattern to every scan, so a token outside
 * it would boot cleanly and then reject every QR code at the door.
 */
const checkinQrToken = required('CHECKIN_QR_TOKEN');

if (!QR_TOKEN_PATTERN.test(checkinQrToken)) {
  throw new Error(
    `Environment variable CHECKIN_QR_TOKEN must match ${QR_TOKEN_PATTERN.source}, as produced by \`openssl rand -hex 16\``,
  );
}

/**
 * The two secrets protect different things and must not be the same value.
 *
 * `PASS_SECRET` signs a 60-second attendee credential and is exercised by every
 * pass in the room; `ADMIN_PASSWORD_PEPPER` is the second half of every stored
 * administrator password and is never transmitted. Sharing one value would mean
 * a weakness found in the high-volume, short-lived use also weakened the
 * long-lived one, and rotating either would silently invalidate the other.
 */
if (passSecret === adminPasswordPepper) {
  throw new Error(
    'ADMIN_PASSWORD_PEPPER must be a different value from PASS_SECRET: generate each with its own `openssl rand -hex 32`',
  );
}

export const env = {
  port: numeric('PORT', 3000),
  nodeEnv: optional('NODE_ENV', 'production'),
  logLevel: optional('LOG_LEVEL', 'info'),
  // Empty disables the rotating file stream, which is the development
  // default: dev logs through pino-pretty on stdout and has no writable log
  // directory. Production sets it to the mount point of the `logs` volume.
  logFileDir: optional('LOG_FILE_DIR', ''),
  // Baked into the production image from `git describe --tags --always --dirty`,
  // so a clean release reads as its tag. `dev` outside a built image, which is
  // honest rather than a fallback worth hiding.
  releaseId: readRelease(),

  /**
   * Outbound alerting. `webhookUrl` empty disables posting without disabling
   * the rules, which still log — useful in development and during a rehearsal,
   * where the alert firing is the thing under test rather than the delivery.
   *
   * `criticalWebhookUrl` is optional and falls back to `webhookUrl`. A separate
   * channel is worth having: the critical rules are the ones that should reach a
   * phone at 20:00, and the warns are the ones that should not.
   */
  alerts: {
    enabled: boolean('ALERT_ENABLED', true),
    webhookUrl: optional('DISCORD_WEBHOOK_URL', ''),
    criticalWebhookUrl: optional('DISCORD_WEBHOOK_URL_CRITICAL', ''),
    dedupTtl: duration('ALERT_DEDUP_TTL', 10 * 60_000),
  },

  /**
   * Load shedding: public requests answered `503` at once instead of joining a
   * queue that only grows. See `docs/performance/load-testing.md` for how the defaults were
   * tuned.
   *
   * `maxLagMs` is judged per half-second window, and a second over it refuses
   * every public request until five seconds pass under it.
   *
   * `maxPoolWaiting` is checked on each request against the live Postgres
   * queue, and refuses only the requests that arrive while the queue is over
   * it. It defaults to twice the pool's `max`, so a burst the pool absorbs
   * within its five-second acquire timeout is served.
   */
  loadShed: {
    enabled: boolean('LOAD_SHED_ENABLED', true),
    maxLagMs: numeric('LOAD_SHED_MAX_LAG_MS', 250),
    maxPoolWaiting: numeric('LOAD_SHED_MAX_POOL_WAITING', 20),
    retryAfterSeconds: numeric('LOAD_SHED_RETRY_AFTER_SECONDS', 5),
  },

  /**
   * The WhatsApp Cloud API, outbound and inbound.
   *
   * `webhookEnabled` is a separate switch from `enabled` on purpose: sending
   * and receiving fail independently, and a deployment that sends without a
   * public callback registered is a valid state rather than a broken one. Both
   * are asserted against their credentials above, so half-configured is refused
   * at boot.
   *
   * `appSecret` is **not** `accessToken`. They are both "the WhatsApp secret"
   * in conversation and they are different credentials from different screens:
   * the access token comes from Business Settings and authorises our outbound
   * calls; the app secret comes from Meta App → Settings → Basic and is the key
   * Meta signs *inbound* webhook bodies with. Using one where the other belongs
   * fails as a `403` on every receipt with nothing else visibly wrong.
   *
   * `webhookPathSecret` is the last segment of the callback path. It is noise
   * reduction rather than a control — the HMAC over the raw body is the
   * boundary — and it is written down here so that nobody later treats it as
   * one, or skips the signature check because the path is hard to guess.
   *
   * `graphVersion` is configurable so that a Graph version deprecation is a
   * `.env` edit on the night rather than a deploy.
   *
   * `doorEnabled` is the lock on the door message, the template sent to an
   * attendee created in `/admin/attendees`. Off, nothing an administrator does
   * in the application turns it on; on, the switch on the roster decides.
   * `budgetUsd` caps what every WhatsApp send of this event may have cost
   * before a door message is refused. Bulk runs are counted against it and are
   * not stopped by it.
   */
  whatsapp: {
    enabled: whatsappEnabled,
    phoneNumberId: optional('WHATSAPP_PHONE_NUMBER_ID', ''),
    accessToken: optional('WHATSAPP_ACCESS_TOKEN', ''),
    graphVersion: optional('WHATSAPP_GRAPH_VERSION', 'v25.0'),
    defaultCountryCode: optional('WHATSAPP_DEFAULT_COUNTRY_CODE', '55'),
    // Milliseconds rather than a `duration`, which cannot express anything
    // below one second. The binding constraint on this number is the quality
    // rating rather than throughput, so the default is 1 000 and not the 12 the
    // published rate limit would allow.
    sendIntervalMs: numeric('WHATSAPP_SEND_INTERVAL_MS', 1_000),
    requestTimeout: duration('WHATSAPP_REQUEST_TIMEOUT', 10_000),
    maxAttempts: numeric('WHATSAPP_MAX_ATTEMPTS', 3),

    doorEnabled: whatsappDoorEnabled,
    doorTemplate: optional('WHATSAPP_DOOR_TEMPLATE', ''),
    doorTemplateVolunteer: optional('WHATSAPP_DOOR_TEMPLATE_VOLUNTEER', ''),
    budgetUsd: numeric('WHATSAPP_BUDGET_USD', 0),

    webhookEnabled: whatsappWebhookEnabled,
    appSecret: optional('WHATSAPP_APP_SECRET', ''),
    webhookVerifyToken: optional('WHATSAPP_WEBHOOK_VERIFY_TOKEN', ''),
    webhookPathSecret: optional('WHATSAPP_WEBHOOK_PATH_SECRET', ''),
  },

  /**
   * How long a row survives in `app_events`.
   *
   * On event day this never fires: the host is destroyed roughly 24 hours
   * afterwards and the default is 72. Its job is the re-used host, so that
   * "the table cannot grow without bound" is a property of the code rather
   * than of the teardown schedule.
   */
  telemetryEventRetention: duration(
    'TELEMETRY_EVENT_RETENTION',
    72 * 3_600_000,
  ),

  appUrl: required('APP_URL'),
  adminUrl: optional('ADMIN_URL', ''),
  appTitle: optional('APP_TITLE', 'PelicanPass'),
  trustedIps: optional('TRUSTED_IPS', ''),

  /**
   * Rate-limit quota overrides, as `prefix=points/duration[,…]`. Parsed and
   * validated by `resolveRateLimits` in `config/rate-limits.ts`, the same way
   * `trustedIps` is parsed where it is used. Empty means every default applies.
   */
  rateLimitOverrides: optional('RATE_LIMIT_OVERRIDES', ''),

  eventId: required('EVENT_ID'),
  checkinQrToken,
  passSecret,

  /**
   * Whether the pass carries the rotating band.
   *
   * The band is an eyes-only control. A scanned pass is settled entirely by its
   * signed token, so turning this off takes nothing away from the scanner; what
   * it gives up is the check a volunteer makes by eye when the camera will not
   * open and the ticket code — which never rotates — is the only identifier in
   * play. Both screens fall back to a clock, which shows liveness but, unlike
   * the band, can be produced by anything that can run a timer.
   *
   * Defaults to on, so no environment loses the control by forgetting to set it.
   */
  passBandEnabled: boolean('PASS_BAND_ENABLED', true),

  /**
   * When the welcome line under the attendee's name switches text, in order.
   *
   * Empty when unset, which keeps the `arrival` text for the whole event.
   */
  passWelcomeSchedule: parseWelcomeSchedule(
    'PASS_WELCOME_SCHEDULE',
    read('PASS_WELCOME_SCHEDULE'),
  ),
  adminPasswordPepper,

  sessionTtl: {
    checkin: numeric('CHECKIN_SESSION_TTL', 600),
    attendee: numeric('ATTENDEE_SESSION_TTL', 3600),
    admin: numeric('ADMIN_SESSION_TTL', 3600),
  },

  /**
   * How long an administrator session may live, however active it is.
   *
   * The Redis TTL above slides on every write, so a tab left open all weekend
   * never ages out. This is the ceiling that ends it regardless — the one
   * session type worth the extra check, since it is the only one that can
   * change data on purpose.
   */
  adminSessionMaxAge: duration('ADMIN_SESSION_MAX_AGE', 12 * 3_600_000),

  postgresConfig: {
    host: required('POSTGRES_HOST'),
    port: numeric('POSTGRES_PORT', 5432),
    database: required('POSTGRES_DB'),
    user: required('POSTGRES_USER'),
    password: required('POSTGRES_PASSWORD'),
  },

  redisConfig: {
    host: required('REDIS_HOST'),
    port: numeric('REDIS_PORT', 6379),
    password: required('REDIS_PASSWORD'),
  },

  captcha: {
    siteKey: required('TURNSTILE_SITE_KEY'),
    secret: required('TURNSTILE_SECRET'),
  },

  /**
   * The administrator sign-in widget, which is a second Turnstile key rather
   * than a reuse of the one above.
   *
   * Turnstile keys carry their own hostname allowlist, and while the tailnet
   * path stands beside the public one the sign-in form answers on both
   * `APP_URL` and `ADMIN_URL`. Adding the tailnet hostname to the attendee key
   * would mean editing the key that carries the door.
   *
   * `enforce` is the switch, not the keys: the form always renders a widget, and
   * this decides only whether a missing or refused token turns the sign-in away.
   * It exists because `TurnstileValidator` never throws — a Cloudflare outage
   * comes back as an unsuccessful result — so an outage would otherwise close
   * the one surface the volunteers have, mid-event. Defaults to enforcing, so no
   * environment becomes laxer by forgetting to set it.
   */
  captchaAdmin: {
    siteKey: required('TURNSTILE_ADMIN_SITE_KEY'),
    secret: required('TURNSTILE_ADMIN_SECRET'),
    enforce: boolean('TURNSTILE_ADMIN_ENFORCE', true),
  },

  /**
   * Cloudflare Access, which the origin verifies for itself.
   *
   * `optional` on both, and the emptiness is load-bearing rather than tolerated:
   * the origin gate deploys **before** the Access application exists, so there is
   * a window in which neither value is known. The middleware refuses every
   * request that did not arrive over the tailnet while either is unset, which
   * makes that window fail closed. The app cannot see whether Caddy has opened
   * the public path, so a boot-time check would have nothing to condition on.
   *
   * `teamDomain` is the full hostname — it is both the JWKS host and the `iss`
   * claim. `aud` is the application's Audience tag, and it is the check that
   * matters on this team: Tolgee sits behind Access on the same team domain, so
   * its tokens carry a valid signature and a valid issuer.
   */
  cfAccess: {
    teamDomain: optional('CF_ACCESS_TEAM_DOMAIN', ''),
    aud: optional('CF_ACCESS_AUD', ''),
  },

  landing: {
    enabled: landingEnabled,
    eventStartAt,
    opensBefore: readOpensBefore(),
    timezone: readEventTimezone(),
    bypassToken: read('LANDING_BYPASS_TOKEN'),

    /**
     * Epoch milliseconds from which the closing page replaces every public
     * page and the attendee API refuses, or `null` to never close. Read
     * whether or not `enabled` is set.
     */
    closesAt: eventClosesAt,
  },

  /**
   * The experience questionnaire's switches and schedule.
   *
   * One switch per audience, so either form can be turned off without the
   * other, and volunteer questions can be committed as a draft before they go
   * live. One schedule, shared: both times are `null` while both switches are
   * off, and neither is read.
   *
   * An audience's form is open when its switch is on, it has a questions file,
   * and the window is open, where an administrator's override in `survey_state`
   * beats the schedule. `survey.window.ts` decides that, and checks at load what
   * this file cannot see: that a switched-on volunteer form has its file, and
   * that the attendee session outlives `closesAt`.
   */
  survey: {
    enabled: surveyEnabled,
    opensAt: surveyOpensAt,
    closesAt: surveyClosesAt,
  },
};
