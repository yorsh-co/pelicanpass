import net from 'net';

import type { Request, RequestHandler } from 'express';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import type { RateLimiterRes } from 'rate-limiter-flexible';

import redis from '../shared/db/redis.ts';
import { RateLimitError } from '../shared/errors/app-error.ts';
import { recordLimiterResult } from '../shared/telemetry/counters.ts';
import { logger } from '../shared/logger/logger.ts';
import { maskUrlSecrets } from '../shared/utils/mask.ts';
import { COOKIE_NAMES } from '../constants/cookie-names.ts';
import { env } from '../config/env.ts';
import { resolveRateLimits } from '../config/rate-limits.ts';
import { panelKey, sessionKey } from './limiter-keys.ts';

import type { RateLimitKey } from '../config/rate-limits.ts';
import type { LimiterKeyBasis, LimiterPurpose } from '../types/limiter.ts';
import type { SessionType } from '../types/session.ts';

/**
 * Picks the limiter that answers for a given key.
 *
 * Replaces an earlier `ConsumableLimiter` wrapper that exposed `consume(key)`
 * and dispatched internally. That hid **which** limiter had answered, and the
 * metrics panel recorded everything against the wrapper's own prefix — so a
 * tiered limiter's trusted and untrusted tiers landed in one row, with a
 * ceiling that flipped between their two quotas depending on which had most
 * recently succeeded. Resolving first and consuming second means the caller
 * always knows the real limiter, and can report against its real prefix.
 */
type LimiterResolver = (key: string) => RateLimiterRedis;

/** The non-tiered case: one limiter answers for every key. */
const fixed =
  (limiter: RateLimiterRedis): LimiterResolver =>
  () =>
    limiter;

/** What a limiter is, in terms an operator can act on. */
export interface LimiterInfo {
  readonly prefix: string;
  readonly points: number;
  readonly duration: number;
  /**
   * What one bucket covers, as a badge.
   *
   * Declared rather than derived from the prefix, because the prefix lies in at
   * least one case: `rl:session:checkin_session_id` sits under `rl:session:` and
   * keys on the **raw cookie**, since the two steps it paces run before the
   * session exists. Badging that `session` would assert the opposite of what it
   * does, and that distinction is the reason its tooltip was written.
   */
  readonly basis:
    | 'ip'
    | 'session'
    | 'cookie'
    | 'username'
    | 'attendee'
    | 'volunteer'
    | 'admin'
    | 'global';

  /** What a bucket is keyed on, named on the panel's tooltip. */
  readonly keyedOn: LimiterKeyBasis;
  /** What it protects and what a refusal means, named on the tooltip. */
  readonly protects: LimiterPurpose;
  /** Which half of a tiered pair, when it is one. */
  readonly tier?: 'strict' | 'trusted' | undefined;
}

/**
 * Every limiter this module defines, declared rather than discovered.
 *
 * The metrics panel used to learn about a limiter only when one was consumed,
 * which made a missing row ambiguous: "no traffic yet" and "the instrumentation
 * is broken" looked identical, and were least distinguishable before the doors
 * opened, when nothing had run. Seeding the panel from here gives every limiter
 * a row and a true ceiling from the first paint.
 *
 * {@link createInsuredLimiter} requires the description, so a limiter cannot be
 * added without one and the registry cannot drift from the definitions.
 */
const registry = new Map<string, LimiterInfo>();

/** Every limiter, for the metrics panel. */
export const limiterRegistry = (): LimiterInfo[] => [...registry.values()];

/**
 * Effective quota for every limiter: the defaults in
 * `src/config/rate-limits.ts` with `RATE_LIMIT_OVERRIDES` applied.
 *
 * @throws {Error} At module load, if the overrides are invalid.
 */
const { limits, overridden } = resolveRateLimits(env.rateLimitOverrides);

// Warned rather than logged at info: an override set for one night should not
// quietly outlive it.
if (overridden.length > 0) {
  logger.warn(
    { overrides: Object.fromEntries(overridden.map((k) => [k, limits[k]])) },
    'Rate limit overrides active',
  );
}

/**
 * Builds a Redis-backed limiter that falls back to an in-process one when
 * Redis is unreachable.
 *
 * Two non-obvious properties: the fallback covers `get()` as well as
 * `consume()`, so {@link isCheckinFailureBudgetExhausted} keeps answering
 * during an outage; and the setter copies `blockDuration` and `execEvenly`
 * from the parent, which is why {@link verificationFailureRateLimiter}'s 900s
 * block is not restated on its insurance twin.
 *
 * State is per-process and lost on restart. `server.ts` runs unclustered, so
 * the memory tier enforces the same quota rather than a multiple of it.
 *
 * It also **registers the limiter**, which is why the description is required
 * rather than optional: the metrics panel is seeded from {@link registry}, and
 * an optional field is one a future limiter would be added without.
 *
 * The quota is looked up from the prefix rather than passed alongside it, so a
 * limiter cannot be paired with another's quota and cannot be added without an
 * entry in `src/config/rate-limits.ts`.
 *
 * @param keyPrefix - Redis key prefix for this limiter, and its quota's key.
 * @param info - What it keys on and what it protects, for the panel.
 */
const createInsuredLimiter = (
  keyPrefix: RateLimitKey,
  info: Pick<LimiterInfo, 'basis' | 'keyedOn' | 'protects'> &
    Partial<Pick<LimiterInfo, 'tier'>>,
): RateLimiterRedis => {
  const quota = limits[keyPrefix];

  registry.set(keyPrefix, {
    prefix: keyPrefix,
    points: quota.points,
    duration: quota.duration,
    ...info,
  });

  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix,
    ...quota,
    insuranceLimiter: new RateLimiterMemory({
      points: quota.points,
      duration: quota.duration,
    }),
  });
};

/**
 * Distinguishes being over quota from the store itself failing.
 *
 * rate-limiter-flexible rejects with a `RateLimiterRes` when the caller is out
 * of points, and with a real error when Redis is unreachable. Only the former
 * carries `msBeforeNext`.
 */
const isRateLimiterRes = (err: unknown): err is RateLimiterRes =>
  typeof err === 'object' &&
  err !== null &&
  typeof (err as { msBeforeNext?: unknown }).msBeforeNext === 'number';

/**
 * Build an Express middleware backed by a rate limiter.
 *
 * @param limiter - Limiter to consume points from.
 * @param getKey - Returns the key to rate limit on, or null to skip limiting
 *   for this request.
 */
const createLimiterMiddleware =
  (
    resolve: LimiterResolver,
    getKey: (req: Request) => string | null,
  ): RequestHandler =>
  async (req, _res, next) => {
    const key = getKey(req);

    if (!key) return next();

    // Resolved before anything is logged or consumed, so every line and every
    // gauge below names the limiter that actually answered rather than a
    // wrapper standing in front of two of them.
    const limiter = resolve(key);

    // `debug`, not `info`: this fires on every request that passes through a
    // limiter, on top of the line pino-http already writes for the same request.
    // At the door that is the single largest contributor to log volume, and it
    // says nothing a refusal does not say better.
    req.log.debug(
      {
        limiter: limiter.keyPrefix,
        identifier: limiter.keyPrefix.includes('session')
          ? `...${key.slice(-4)}`
          : key,
        method: req.method,
        path: maskUrlSecrets(req.originalUrl),
      },
      'Rate limiter consumed',
    );

    try {
      // The result was discarded here until the metrics panel needed it. It
      // carries consumedPoints and remainingPoints, whose sum is the ceiling of
      // whichever tier answered — which is the only way to know it for the
      // tiered limiters, where one keyPrefix fronts two different quotas.
      const res = await limiter.consume(key);

      recordLimiterResult(
        limiter.keyPrefix,
        panelKey(registry.get(limiter.keyPrefix)?.basis, key),
        res.consumedPoints,
        false,
      );

      next();
    } catch (err) {
      // internal failures reject with a real error rather than a
      // RateLimiterRes, and must not be reported as rate limiting
      if (!isRateLimiterRes(err)) {
        req.log.error({ err }, 'Rate limiter error');
        return next();
      }

      recordLimiterResult(
        limiter.keyPrefix,
        panelKey(registry.get(limiter.keyPrefix)?.basis, key),
        err.consumedPoints,
        true,
      );

      const retryAfterSeconds = Math.ceil(err.msBeforeNext / 1000);
      return next(new RateLimitError('Too many requests', retryAfterSeconds));
    }
  };

/**
 * Records a manually-consumed budget onto the metrics panel.
 *
 * The four failure budgets are consumed from services rather than mounted as
 * middleware, so `createLimiterMiddleware` never sees them. They are also the
 * four an abuse panel is actually read for — instrumenting only the middleware
 * would produce a panel that looks complete while missing every budget.
 *
 * @param limiter - The limiter that was consumed.
 * @param key - What it keyed on.
 * @param result - The resolved result, or the `RateLimiterRes` rejection.
 * @param refused - Whether this consume went over.
 */
const recordBudget = (
  limiter: RateLimiterRedis,
  key: string,
  result: RateLimiterRes,
  refused: boolean,
): void => {
  recordLimiterResult(
    limiter.keyPrefix,
    panelKey(registry.get(limiter.keyPrefix)?.basis, key),
    result.consumedPoints,
    refused,
  );
};

/**
 * Addresses and subnets from `TRUSTED_IPS`, as a matcher.
 *
 * `net.BlockList` is Node's own subnet matcher, which is why there is no
 * `ipaddr.js` here. It also resolves the case that actually bites: Express
 * hands back `::ffff:1.2.3.4` whenever the peer socket is IPv6, and BlockList
 * matches that against an IPv4 rule as long as it is told the address is v6 —
 * which `net.isIP` reports correctly, so the family is passed straight through.
 *
 * @throws {Error} At module load, if an entry is neither an address nor a
 *   CIDR.
 */
const buildTrustedIpMatcher = (raw: string): net.BlockList => {
  const list = new net.BlockList();

  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [address = '', prefix] = entry.split('/');
    const family = net.isIP(address);

    if (family === 0) {
      throw new Error(
        `TRUSTED_IPS contains "${entry}", which is not an IP address or CIDR range`,
      );
    }

    const type = family === 6 ? 'ipv6' : 'ipv4';

    if (prefix === undefined) {
      list.addAddress(address, type);
      continue;
    }

    const bits = Number(prefix);
    const maxBits = family === 6 ? 128 : 32;

    if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) {
      throw new Error(
        `TRUSTED_IPS contains "${entry}", whose prefix length must be an integer between 0 and ${String(maxBits)}`,
      );
    }

    list.addSubnet(address, bits, type);
  }

  return list;
};

const trustedIps = buildTrustedIpMatcher(env.trustedIps);

const isTrustedIp = (ip: string): boolean => {
  const family = net.isIP(ip);

  if (family === 0) return false;

  return trustedIps.check(ip, family === 6 ? 'ipv6' : 'ipv4');
};

/** A prefix whose `:trusted` twin also has a quota. */
type TieredPrefix = {
  [K in RateLimitKey]: `${K}:trusted` extends RateLimitKey ? K : never;
}[RateLimitKey];

/**
 * Build a per-IP limiter with a relaxed quota for the trusted
 * gateway IPs and a strict quota for everyone else. Reuses
 * createLimiterMiddleware so error handling/logging stays in one place.
 *
 * @param basePrefix - Redis key prefix for the strict tier; the trusted tier is
 *   `${basePrefix}:trusted`.
 */
const createTieredIpLimiter = (
  basePrefix: TieredPrefix,
  info: Pick<LimiterInfo, 'protects'>,
): RequestHandler => {
  const strictLimiter = createInsuredLimiter(basePrefix, {
    basis: 'ip',
    keyedOn: 'ipStrict',
    tier: 'strict',
    ...info,
  });

  const trustedLimiter = createInsuredLimiter(`${basePrefix}:trusted`, {
    basis: 'ip',
    keyedOn: 'ipTrusted',
    tier: 'trusted',
    ...info,
  });

  // Resolved rather than wrapped. The wrapper this replaced reported both tiers
  // under one prefix, so the panel showed a single row whose ceiling flipped
  // between 300 and 2000 depending on which tier last answered — worthless in
  // exactly the situation the panel exists for, since adding an address to
  // TRUSTED_IPS is the remedy it recommends.
  return createLimiterMiddleware(
    (ip) => (isTrustedIp(ip) ? trustedLimiter : strictLimiter),
    (req) => req.ip ?? null,
  );
};

/**
 * Global per-IP limiter.
 * Protects all /api/v1 routes (checkin, attendee, admin) from a single
 * client hammering the API, regardless of session state
 *
 * The strict tier is 300 rather than 60 because an in-person event does not
 * produce one attendee per address. Venue WiFi puts the whole room behind one,
 * and Brazilian carrier CGNAT puts an unpredictable slice of the room behind
 * others that cannot be listed in TRUSTED_IPS ahead of time. One check-in
 * costs 3 requests at best and about 6 in practice, so 300 carries roughly 50
 * arrivals a minute from a single address.
 *
 * That is a deliberate loosening of a control that was never the boundary:
 * see {@link checkinEntryIpLimiter} for what actually stops guessing, none of
 * which keys on IP.
 */
export const ipLimiter = createTieredIpLimiter('rl:ip', {
  protects: 'api',
});

/**
 * Light, global per-IP limiter for web (EJS-rendered) routes.
 * Mainly a baseline guard against a single source hammering / or
 * /admin/login, since each render still costs a Redis session lookup.
 *
 * The strict tier is 300 rather than 100 for the same reason as
 * {@link ipLimiter}'s: carrier CGNAT addresses cannot be trusted ahead of
 * time. After a raffle draw the room opens its pass about 1.2 times a phone
 * in a minute, so 100 refused everyone past roughly 83 phones on one
 * address; the load test's one-dominant-carrier room (about 210 phones per
 * address) lost half its opens at 100 and none at 300, which carries about
 * 250. Five renders a second from one source is still a small cost.
 */
export const webLimiter = createTieredIpLimiter('rl:ip:web', {
  protects: 'web',
});

/**
 * Build a per-session rate limiter middleware, keyed on a resolved session
 * ID. Covers the case where a session alone (independent of IP) is used to spam
 * an endpoint — a leaked or guessed admin/attendee session — and complements
 * the IP limiter for shared-IP scenarios (event WiFi/NAT).
 *
 * The key is `req.sessionIds[type]` — written by `resolveSessions` once the
 * store has confirmed the session — not the raw cookie, so a client rotating
 * random IDs mints no budget and creates no Redis keys.
 *
 * Must be mounted after `resolveSessions`.
 *
 * @param type - Session type to key on.
 */
const createSessionLimiter = (type: SessionType): RequestHandler => {
  const limiter = createInsuredLimiter(`rl:session:${type}`, {
    basis: 'session',
    keyedOn: `${type}Session`,
    protects: `${type}SessionRoutes`,
  });

  return createLimiterMiddleware(fixed(limiter), (req) =>
    sessionKey(req.sessionIds?.[type]),
  );
};

/**
 * Per-checkin-session limiter.
 * Protects against a single session spamming requests,
 * independent of IP (covers shared NAT/WiFi at in-person
 * event where many users share an IP)
 *
 * Mounted below `requireSessionType('checkin')`, so it only ever sees a session
 * the store resolved. The two steps that *create* a session run above it and
 * use {@link checkinEntryPacingLimiter} instead.
 */
export const checkinSessionLimiter = createSessionLimiter('checkin');

/**
 * Pacing limiter for the two check-in steps that create a session.
 *
 * `POST /ticket` and `POST /qr` run before `resolveSessions` because they are
 * what issue the session, so there is no resolved ID to key on and this reads
 * the cookie directly.
 *
 * **Pacing, not a control.** A client rotating `checkin_session_id` gets a
 * fresh budget every request; only {@link ipLimiter}'s key cannot be rotated.
 *
 * It is kept for the honest case: behind venue NAT the room shares one address,
 * so one runaway client would otherwise eat the shared 300/min IP budget.
 */
export const checkinEntryPacingLimiter = createLimiterMiddleware(
  fixed(
    createInsuredLimiter('rl:session:checkin_session_id', {
      // Not `session`, despite the `rl:session:` prefix: these two steps run
      // before `resolveSessions`, so the raw cookie is all there is to key on.
      // Badging it `session` would assert the opposite of what it does.
      basis: 'cookie',
      keyedOn: 'checkinCookie',
      protects: 'checkinCreation',
    }),
  ),
  (req) => {
    // cookie-parser types req.cookies as `any`.
    const cookies = req.cookies as Record<string, string | undefined>;

    // An absent or empty cookie yields null, and the request goes unpaced.
    return sessionKey(cookies[COOKIE_NAMES.checkin]);
  },
);

/**
 * Per-attendee-session limiter.
 * Same rationale as checkinSessionLimiter - guards against a
 * leaked/guessed attendee_session_id being used to hammer attendee routes.
 */
export const attendeeSessionLimiter = createSessionLimiter('attendee');

/**
 * Per-session limiter for the staff surface.
 *
 * Built by hand rather than with {@link createSessionLimiter} because that
 * helper derives both the key prefix and the key itself from one `SessionType`,
 * and there is no `'staff'` session — the surface runs on the volunteer's own
 * attendee session. Keying on `attendee` while prefixing `staff` keeps the two
 * budgets separate: a volunteer hammering the scanner should not spend the
 * quota their own pass is polling against.
 *
 * Sixty a minute against a surface where one redemption is a verify and a
 * redeem, so roughly thirty handovers a minute from one phone — well past what
 * a person can physically do, and far short of anything worth scripting.
 *
 * Keyed on the session, not the IP: the venue is behind one NAT address, and
 * Cloudflare's free plan cannot key a rule on "IP with NAT support".
 *
 * Must be mounted after `resolveSessions`.
 */
export const staffSessionLimiter = createLimiterMiddleware(
  fixed(
    createInsuredLimiter('rl:session:staff', {
      basis: 'session',
      keyedOn: 'volunteerSession',
      protects: 'staffCounters',
    }),
  ),
  (req) => sessionKey(req.sessionIds?.attendee),
);

/**
 * Per-admin-session limiter.
 * Tighter than the user limiter since admin routes are higher value
 * and admin traffic volume is naturally much lower.
 */
export const adminSessionLimiter = createSessionLimiter('admin');

/**
 * The metrics panel's own budget, and a deliberate exception.
 *
 * {@link adminSessionLimiter} is 20 requests a minute. The dashboard polls every
 * five seconds, which is twelve a minute on its own — so an administrator with
 * the panel open on a second screen would have eight requests a minute left for
 * the roster, the lookup and everything else, and would start seeing 429s on the
 * work the panel exists to support.
 *
 * Built directly rather than through {@link createSessionLimiter}, which would
 * reuse the `rl:session:admin` prefix and therefore the very counter this exists
 * to escape.
 *
 * Same shape as the documented exemption of `/attendee/pass` from `ipLimiter`
 * in `api/index.ts`, and the same reasoning: the limiter being escaped was never
 * the boundary for this route, only the thing that would break first. What bounds
 * it is that the route sits behind `requireSessionType('admin')` and
 * `requireAdminScope('metrics:read')`, reachable only through Cloudflare Access
 * on the public hostname or through the tailnet listener.
 *
 * Sixty a minute is five times the poll rate, leaving room for a manual refresh
 * and a second tab without leaving room for a loop. It appears on the panel it
 * serves, which is a pleasing way to notice a runaway poller.
 */
export const metricsPollLimiter = createLimiterMiddleware(
  fixed(
    createInsuredLimiter('rl:session:admin:metrics', {
      basis: 'session',
      keyedOn: 'adminSession',
      protects: 'metricsPanel',
    }),
  ),
  (req) => sessionKey(req.sessionIds?.admin),
);

/**
 * The WhatsApp sender's progress poll, and the same deliberate exception as
 * {@link metricsPollLimiter}.
 *
 * The sender screen polls every three seconds while a run is going, which is
 * twenty requests a minute — the whole of {@link adminSessionLimiter}'s budget
 * on its own, leaving the stop button it sits beside to answer 429.
 *
 * Built directly rather than through {@link createSessionLimiter}, which would
 * reuse the `rl:session:admin` prefix and so the counter this exists to escape.
 * A prefix of its own rather than the metrics one, so an operator with both
 * screens open does not have one poll starve the other.
 *
 * What bounds the route is what bounds the metrics panel: an admin session, the
 * `whatsapp:send` scope, and Cloudflare Access or the tailnet in front of both.
 * Sixty a minute is three times the poll rate.
 */
export const whatsappPollLimiter = createLimiterMiddleware(
  fixed(
    createInsuredLimiter('rl:session:admin:whatsapp', {
      basis: 'session',
      keyedOn: 'adminSession',
      protects: 'whatsappSender',
    }),
  ),
  (req) => sessionKey(req.sessionIds?.admin),
);

/**
 * The redemptions screen's totals poll, and the same deliberate exception as
 * {@link metricsPollLimiter}.
 *
 * The screen refreshes every ten seconds, six requests a minute, which on its
 * own would leave {@link adminSessionLimiter}'s 20 for the corrections beside
 * it — until a second tab, or an operator who left it open next to the record
 * page, used the rest and the undo button answered 429.
 *
 * A prefix of its own rather than the metrics one, so an operator watching
 * both screens does not have one poll starve the other. Bounded like the
 * others: an admin session, the `redemptions:read` scope, and Cloudflare Access
 * or the tailnet in front of both. Sixty a minute is ten times the poll rate,
 * room for several tabs.
 */
export const redemptionsPollLimiter = createLimiterMiddleware(
  fixed(
    createInsuredLimiter('rl:session:admin:redemptions', {
      basis: 'session',
      keyedOn: 'adminSession',
      protects: 'redemptionsPanel',
    }),
  ),
  (req) => sessionKey(req.sessionIds?.admin),
);

/**
 * Ceiling on `/readyz`, held entirely in this process.
 *
 * **Deliberately not {@link createInsuredLimiter}.** That builds a
 * `RateLimiterRedis`, so every consume is a Redis round trip — and the cost this
 * is meant to bound *is* a Redis `PING` plus a Postgres `SELECT 1`. Limiting the
 * endpoint that way would have swapped the ping for an `INCR` and protected
 * nothing. `RateLimiterMemory` costs a map lookup and touches neither
 * dependency, which is the only shape that makes sense here.
 *
 * The real protection is the one-second cache in `telemetry/probes.ts`: it caps
 * the dependency cost at one reading per second however many requests arrive,
 * and refuses nobody. This is the ceiling on raw request handling behind it.
 *
 * **Sized loose on purpose, and it has to be.** `/readyz` answers only on the
 * `:8080` listener, where each tailnet device is its own key, but every
 * dashboard an operator has open on that device shares it — five falling back
 * to `/readyz` during an outage is already 60 a minute of entirely legitimate
 * traffic. An endpoint whose whole purpose is to answer while things are broken
 * must not start refusing at the moment it is most needed, so the ceiling sits
 * well clear of any plausible honest load and exists only to bound a runaway
 * loop.
 *
 * Not registered through `createLimiterMiddleware`: that records into the
 * metrics panel, and a limiter the panel's own fallback consumes would report
 * on itself.
 */
const readyzLimiter = new RateLimiterMemory(limits.readyz);

/**
 * Bounds how often `/readyz` may be asked, per address.
 *
 * Fails open. A limiter that cannot answer must not take a readiness probe down
 * with it — the whole point of the endpoint is to keep answering when other
 * things are not.
 */
export const readyzRateLimit: RequestHandler = (req, _res, next) => {
  const key = req.ip;

  if (!key) return next();

  readyzLimiter
    .consume(key)
    .then(() => {
      next();
    })
    .catch((err: unknown) => {
      if (!isRateLimiterRes(err)) return next();

      next(
        new RateLimitError(
          'Too many readiness checks',
          Math.ceil(err.msBeforeNext / 1000),
        ),
      );
    });
};

/**
 * Budget for the unauthenticated client-error endpoint.
 *
 * Two tiers, because one address and the whole venue are different threats. The
 * per-IP tier stops a single phone in a retry loop; the global tier is what
 * bounds the disk when a bad deploy makes seven hundred phones throw the same
 * error at the same moment — which is the realistic failure here, not an
 * attacker. The reporter caps itself at five per page load, but a client-side
 * cap is a courtesy and not a control.
 *
 * **The per-IP tier is 60, not the 5 a single device would need**, and that is
 * the same correction {@link ipLimiter} already carries: "an in-person event
 * does not produce one attendee per address. Venue WiFi puts the whole room
 * behind one, and Brazilian carrier CGNAT puts an unpredictable slice of the
 * room behind others." At five a minute the entire venue would share a budget
 * one phone could spend, and the client-error spike rule — which fires above
 * twenty a minute — could never fire at all. Measured before the change: 25
 * reports from one address were accepted 5 and refused 20.
 *
 * Sixty is still far below what a genuinely broken bundle would produce: seven
 * hundred phones capped at five reports each is thirty-five hundred. That is
 * deliberate. This endpoint exists for **detection, not collection** —
 * twenty-one reports prove the same thing three thousand do, and only one of
 * those numbers has to be stored.
 */
export const clientErrorIpLimiter = createInsuredLimiter(
  'rl:ip:client-errors',
  {
    // IP-keyed but not tiered, so it needs a badge of its own — "strict" and
    // "trusted" imply an IP limiter, and this one has neither.
    basis: 'ip',
    keyedOn: 'ip',
    protects: 'clientErrorsIp',
  },
);

const clientErrorGlobalLimiter = createInsuredLimiter(
  'rl:global:client-errors',
  {
    basis: 'global',
    keyedOn: 'global',
    protects: 'clientErrorsGlobal',
  },
);

/**
 * Charges one client-error report against both tiers.
 *
 * Consumed from the controller rather than mounted as middleware because the
 * global tier keys on a constant, which `createLimiterMiddleware` has no way to
 * express — the same shape as the failure budgets above.
 *
 * @param ip - The reporting address.
 * @returns Whether the report should be refused.
 */
export const consumeClientErrorBudget = async (
  ip: string,
): Promise<{ blocked: boolean; retryAfterSeconds?: number }> => {
  for (const [limiter, key] of [
    [clientErrorIpLimiter, ip],
    [clientErrorGlobalLimiter, 'global'],
  ] as const) {
    try {
      const res = await limiter.consume(key);

      recordBudget(limiter, key, res, false);
    } catch (err) {
      if (!isRateLimiterRes(err)) {
        logger.error({ err }, 'Rate limiter error');

        continue;
      }

      recordBudget(limiter, key, err, true);

      return {
        blocked: true,
        retryAfterSeconds: Math.ceil(err.msBeforeNext / 1000),
      };
    }
  }

  return { blocked: false };
};

/**
 * Budget for the WhatsApp receipt callback.
 *
 * A pair for the reason the client-error pair is one, and more so: **Meta
 * delivers from many addresses**, so a per-IP counter alone caps nothing in
 * aggregate. The global tier is the one doing the work here.
 *
 * Sized against the run rather than against abuse. Seven hundred recipients
 * produce up to ~2 100 status events — three per message — inside about twelve
 * minutes, and Meta batches them unpredictably. 600/60 per address and 1 200/60
 * overall leave several times that headroom, because **the cost of being wrong
 * is asymmetric**: a `429` to Meta is not a refusal, it is a redelivery, and a
 * redelivery storm caused by our own throttle is worse than the traffic it was
 * meant to bound.
 *
 * This pair is also the whole per-request throttle for this path: the Free
 * plan's single rate limiting rule is spent on `/checkin`, and
 * `docs/infrastructure/cloudflare-rules.md` records that the application's limiters are the
 * replacement rather than a supplement.
 */
export const whatsappWebhookIpLimiter = createInsuredLimiter(
  'rl:ip:whatsapp-webhook',
  {
    basis: 'ip',
    keyedOn: 'ip',
    protects: 'whatsappWebhookIp',
  },
);

const whatsappWebhookGlobalLimiter = createInsuredLimiter(
  'rl:global:whatsapp-webhook',
  {
    basis: 'global',
    keyedOn: 'global',
    protects: 'whatsappWebhookGlobal',
  },
);

/**
 * Charges one receipt delivery against both tiers.
 *
 * Consumed from the controller **before any verification work**, so a flood
 * costs a Redis increment rather than an HMAC per request. Same shape as
 * {@link consumeClientErrorBudget}, and for the same reason: the global tier
 * keys on a constant, which `createLimiterMiddleware` cannot express.
 *
 * @param ip - The delivering address.
 * @returns Whether the delivery should be refused.
 */
export const consumeWhatsappWebhookBudget = async (
  ip: string,
): Promise<{ blocked: boolean; retryAfterSeconds?: number }> => {
  for (const [limiter, key] of [
    [whatsappWebhookIpLimiter, ip],
    [whatsappWebhookGlobalLimiter, 'global'],
  ] as const) {
    try {
      const res = await limiter.consume(key);

      recordBudget(limiter, key, res, false);
    } catch (err) {
      if (!isRateLimiterRes(err)) {
        logger.error({ err }, 'Rate limiter error');

        continue;
      }

      recordBudget(limiter, key, err, true);

      return {
        blocked: true,
        retryAfterSeconds: Math.ceil(err.msBeforeNext / 1000),
      };
    }
  }

  return { blocked: false };
};

/**
 * Per-IP pacing limiter for the admin login endpoint.
 *
 * {@link adminSessionLimiter} cannot cover this route: it keys on
 * `req.sessionIds.admin`, which by definition does not exist before a
 * successful login, and `createLimiterMiddleware` skips limiting when the key
 * is null. Without this, the only per-request bound on login would be the
 * global `ipLimiter`.
 *
 * Sized for operators rather than for a venue: `requireAccessAssertion` runs
 * ahead of this on the public hostname and the tailnet listener is private, so
 * every request it counts comes from someone already past Cloudflare Access or
 * on the tailnet. There is no NAT crowd behind one address here — a handful of
 * operator devices, each making one login attempt at a time. Ten a minute is
 * generous for a person typing and far below what makes scrypt worth attacking.
 */
export const adminLoginLimiter = createTieredIpLimiter('rl:ip:admin-login', {
  protects: 'adminLogin',
});

/**
 * Per-username failure limiter for the admin login.
 *
 * Keyed on the username being attempted rather than on the session or the IP,
 * so it survives an attacker discarding cookies or moving between addresses.
 * There is exactly one legitimate person per username, which is what makes so
 * tight a threshold safe — the same reasoning as
 * {@link consumeVerificationFailure}, which this mirrors.
 *
 * `blockDuration` matters more than the count: ten wrong passwords locks that
 * one account for fifteen minutes, so guessing costs wall-clock time rather
 * than CPU. It cannot lock a real administrator out of anything but their own
 * name, and only for as long as the attempt continues.
 *
 * **Consumed up front, on every attempt, and released again on success** — not
 * only on failure like its verification counterpart. Charging first is what
 * keeps a flood cheap: the point is spent before scrypt runs, so a refused
 * attempt costs a Redis round trip instead of 100 ms of CPU. Charging first
 * would also spend a real administrator's budget on their ordinary sign-ins, so
 * {@link resetAdminLoginFailures} hands the points back the moment credentials
 * check out. Only attempts that failed leave a mark.
 */
const adminLoginFailureRateLimiter = createInsuredLimiter(
  'rl:admin:login-failures',
  {
    basis: 'username',
    keyedOn: 'adminUsername',
    protects: 'adminLoginFailures',
  },
);

/**
 * Consume one point against a username's admin login budget.
 *
 * @param username - Username being attempted, already normalised.
 * @returns Whether the budget is exhausted, and how long to wait if so.
 */
export const consumeAdminLoginFailure = async (
  username: string,
): Promise<{ blocked: boolean; retryAfterSeconds?: number }> => {
  try {
    const res = await adminLoginFailureRateLimiter.consume(username);

    recordBudget(adminLoginFailureRateLimiter, username, res, false);

    return { blocked: false };
  } catch (err) {
    if (!isRateLimiterRes(err)) {
      logger.error({ err }, 'Rate limiter error');

      return { blocked: false };
    }

    recordBudget(adminLoginFailureRateLimiter, username, err, true);

    return {
      blocked: true,
      retryAfterSeconds: Math.ceil(err.msBeforeNext / 1000),
    };
  }
};

/**
 * Clear a username's admin login budget after a successful sign-in.
 *
 * Best-effort. A failure here leaves the administrator's own attempts counted
 * against them, which costs them nothing until they have made ten in fifteen
 * minutes — worth a warning, not worth failing a login that has already
 * succeeded.
 *
 * @param username - Username that just signed in, already normalised.
 */
export const resetAdminLoginFailures = async (
  username: string,
): Promise<void> => {
  try {
    await adminLoginFailureRateLimiter.delete(username);
  } catch (err) {
    logger.warn({ err }, 'Could not reset the admin login budget');
  }
};

/**
 * Per-IP limiter for GET /checkin specifically.
 *
 * This route accepts an attacker-controlled ticket code (?t=) or qr token
 * (?k=) and hits Postgres/Redis on every request, making it a ticket-guessing
 * surface independent of the POST /api/v1/checkin/* endpoints.
 *
 * Sized for venue NAT, where hundreds of arrivals share one address, and for
 * the fact that a `?t=` entry costs **two** points: the handler consumes the
 * token into the session and 303s to a bare `/checkin`, back through here. At
 * 60 points that is 30 `?t=` arrivals a minute. Rejections here come from
 * middleware, so they land in `webErrorHandler` as a plain 429 rather than the
 * route's redirect-on-error.
 *
 * This is cost control, not a guessing control. The controls that stop guessing
 * do not key on IP and so are not blunted by NAT:
 * {@link consumeCheckinEntryFailure} budgets 30 failures a minute globally and
 * {@link consumeVerificationFailure} 10 per attendee per 15 minutes.
 */
export const checkinEntryIpLimiter = createTieredIpLimiter(
  'rl:ip:checkin-entry',
  {
    protects: 'checkinEntry',
  },
);

/**
 * Global (non-IP-keyed) failure limiter for GET /checkin.
 * This is consumed only when a ticket/QR lookup
 * fails - it tracks brute-force guessing specifically,
 * not legitimate traffic. This lets the threshold be set much lower
 * without risking false positives on real attendees, since real
 * traffic is overwhelmingly successful lookups.
 *
 * Must be consumed manually from the service layer (see
 * consumeCheckinEntryFailure below) once a lookup is known to have
 * failed - it is not wired as route middleware.
 */
const checkinEntryFailureRateLimiter = createInsuredLimiter(
  'rl:global:checkin-entry-failures',
  {
    basis: 'global',
    keyedOn: 'global',
    protects: 'checkinEntryFailures',
  },
);

/**
 * Consume one point against the global checkin-entry failure budget.
 * Call this after a ticket/QR lookup fails.
 *
 * @returns Whether the budget is exhausted, and how long to wait if so.
 */
export const consumeCheckinEntryFailure = async (): Promise<{
  blocked: boolean;
  retryAfterSeconds?: number;
}> => {
  try {
    const res = await checkinEntryFailureRateLimiter.consume('global');

    recordBudget(checkinEntryFailureRateLimiter, 'global', res, false);

    return { blocked: false };
  } catch (err) {
    if (!isRateLimiterRes(err)) {
      logger.error({ err }, 'Rate limiter error');

      return { blocked: false };
    }

    recordBudget(checkinEntryFailureRateLimiter, 'global', err, true);

    return {
      blocked: true,
      retryAfterSeconds: Math.ceil(err.msBeforeNext / 1000),
    };
  }
};

/**
 * Reports whether the global checkin-entry failure budget is spent.
 *
 * This is read rather than consumed, and it is what raises the captcha
 * requirement for everyone while the budget is exhausted. The state lives in
 * Redis rather than in a session on purpose: a session-held flag is cleared by
 * discarding a cookie, which is exactly the bypass this defends against.
 *
 * With Redis unreachable this reads the in-process insurance tier rather than
 * throwing — `get()` is covered by the fallback, so the flag keeps tracking the
 * failures the same process counted. The catch below is the last resort for
 * everything else, and fails open: a store failure should not put the whole
 * check-in flow behind a captcha.
 *
 * @returns Whether callers should currently be required to solve a captcha.
 */
export const isCheckinFailureBudgetExhausted = async (): Promise<boolean> => {
  try {
    const res = await checkinEntryFailureRateLimiter.get('global');

    return res !== null && res.remainingPoints <= 0;
  } catch (err) {
    logger.error({ err }, 'Rate limiter error');

    return false;
  }
};

/**
 * Per-attendee failure limiter for the verification step.
 *
 * Keyed on the attendee being verified rather than on a session or an IP, so
 * it survives the attacker discarding their cookie and is unaffected by the
 * whole venue sharing one NAT address. There is exactly one legitimate person
 * per attendee ID, which is what makes so tight a threshold safe.
 *
 * Consumed manually from the service once a verification attempt is known to
 * have failed; it is not wired as route middleware.
 */
const verificationFailureRateLimiter = createInsuredLimiter(
  'rl:attendee:verification-failures',
  {
    basis: 'attendee',
    keyedOn: 'verifiedAttendee',
    protects: 'verificationFailures',
  },
);

/**
 * Consume one point against an attendee's verification failure budget.
 *
 * @param attendeeId - Attendee whose verification attempt failed.
 * @returns Whether the budget is exhausted, and how long to wait if so.
 */
export const consumeVerificationFailure = async (
  attendeeId: string,
): Promise<{ blocked: boolean; retryAfterSeconds?: number }> => {
  try {
    const res = await verificationFailureRateLimiter.consume(attendeeId);

    recordBudget(verificationFailureRateLimiter, attendeeId, res, false);

    return { blocked: false };
  } catch (err) {
    if (!isRateLimiterRes(err)) {
      logger.error({ err }, 'Rate limiter error');

      return { blocked: false };
    }

    recordBudget(verificationFailureRateLimiter, attendeeId, err, true);

    return {
      blocked: true,
      retryAfterSeconds: Math.ceil(err.msBeforeNext / 1000),
    };
  }
};

/**
 * Per-volunteer failure limiter for the staff quick lookup.
 *
 * `/staff/lookup` resolves a typed ticket code straight to a review, bypassing
 * the pass token and the band — that is the point of it, and
 * `git show d0aa585:docs/anti-fraud-pass-plan.md` (in the private archive
 * repository) records it as the broken-camera path. What it leaves behind is an oracle: a well-formed code
 * either answers with an attendee's identifier and entitlements or answers 404,
 * and until this existed nothing counted the misses.
 *
 * {@link staffSessionLimiter} was the only bound on it, and a blunt 60/min is
 * the control {@link checkinEntryIpLimiter} explicitly disclaims — "cost
 * control, not a guessing control". Every other guessing surface in this
 * application is bounded by a failure budget that does not key on IP, and this
 * is that budget for the last one that lacked it.
 *
 * Keyed on the volunteer's own attendee ID rather than the session or the IP,
 * the same reasoning as {@link verificationFailureRateLimiter}: the venue shares
 * one NAT address, the session is already bound to that ID, and there is exactly
 * one legitimate person behind it.
 *
 * **Only well-formed but unissued codes reach it.** The staff page runs
 * `isValidTicketCode` before the round trip and the service rejects a malformed
 * query as a `ValidationError` without charging, so an honest mistype spends
 * nothing — which is what makes fifteen a generous threshold rather than a tight
 * one.
 *
 * Five minutes rather than the fifteen its verification counterpart uses. This
 * one can lock out a volunteer working a counter, and a station that goes quiet
 * for a quarter of an hour is a worse outcome at a live event than the guessing
 * it would prevent.
 *
 * Consumed manually from the service once a lookup is known to have missed; it
 * is not wired as route middleware.
 */
const staffLookupFailureRateLimiter = createInsuredLimiter(
  'rl:staff:lookup-failures',
  {
    basis: 'volunteer',
    keyedOn: 'lookupVolunteer',
    protects: 'lookupFailures',
  },
);

/**
 * Consume one point against a volunteer's staff lookup failure budget.
 *
 * @param volunteerId - Attendee ID of the volunteer whose lookup missed.
 * @returns Whether the budget is exhausted, and how long to wait if so.
 */
export const consumeStaffLookupFailure = async (
  volunteerId: string,
): Promise<{ blocked: boolean; retryAfterSeconds?: number }> => {
  try {
    const res = await staffLookupFailureRateLimiter.consume(volunteerId);

    recordBudget(staffLookupFailureRateLimiter, volunteerId, res, false);

    return { blocked: false };
  } catch (err) {
    if (!isRateLimiterRes(err)) {
      logger.error({ err }, 'Rate limiter error');

      return { blocked: false };
    }

    recordBudget(staffLookupFailureRateLimiter, volunteerId, err, true);

    return {
      blocked: true,
      retryAfterSeconds: Math.ceil(err.msBeforeNext / 1000),
    };
  }
};

/**
 * Per-administrator ceiling on door messages.
 *
 * **A cost control.** Each attendee created in `/admin/attendees` with the
 * message ticked is a paid send, and the operator doing it may not know that.
 * `WHATSAPP_BUDGET_USD` is the hard stop; this is what keeps one account from
 * spending the budget in minutes. 30 in 10 minutes is more than one person
 * types by hand at a door.
 *
 * Keyed on the admin ID rather than the session, so signing in again does not
 * buy a fresh budget. Consumed from the door service once the lock, the switch
 * and the phone number have passed, just before the budget is checked; a
 * refusal skips the message and still creates the attendee.
 */
const whatsappDoorRateLimiter = createInsuredLimiter('rl:admin:whatsapp-door', {
  basis: 'admin',
  keyedOn: 'admin',
  protects: 'whatsappDoor',
});

/**
 * Consume one door message against an administrator's budget.
 *
 * @param adminId - `admins.admin_id` of the administrator creating the attendee.
 * @returns Whether the budget is exhausted, and how long to wait if so.
 */
export const consumeWhatsappDoorBudget = async (
  adminId: string,
): Promise<{ blocked: boolean; retryAfterSeconds?: number }> => {
  try {
    const res = await whatsappDoorRateLimiter.consume(adminId);

    recordBudget(whatsappDoorRateLimiter, adminId, res, false);

    return { blocked: false };
  } catch (err) {
    if (!isRateLimiterRes(err)) {
      logger.error({ err }, 'Rate limiter error');

      return { blocked: false };
    }

    recordBudget(whatsappDoorRateLimiter, adminId, err, true);

    return {
      blocked: true,
      retryAfterSeconds: Math.ceil(err.msBeforeNext / 1000),
    };
  }
};
