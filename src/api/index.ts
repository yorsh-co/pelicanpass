import express from 'express';

import checkinRoutes from '../modules/checkin/checkin.routes.ts';
import adminRoutes from '../modules/admin/admin.routes.ts';
import adminAuthRoutes from '../modules/admin/admin.auth.routes.ts';
import attendeeRoutes from '../modules/attendee/attendee.routes.ts';
import surveyRoutes from '../modules/survey/survey.routes.ts';
import staffRoutes from '../modules/staff/staff.routes.ts';
import metricsRoutes from '../modules/metrics/metrics.routes.ts';
import clientErrorRoutes from '../modules/client-error/client-error.routes.ts';
import raffleRoutes from '../modules/raffle/raffle.routes.ts';
import whatsappWebhookRoutes from '../modules/whatsapp/whatsapp.webhook.routes.ts';
import { currentRun as whatsappCurrentRun } from '../modules/admin/admin.whatsapp.controller.ts';
import { summary as redemptionsSummary } from '../modules/admin/admin.redemptions.controller.ts';
import { env } from '../config/env.ts';

import { requireAdminLoginCaptcha } from '../middleware/admin-login-captcha.middleware.ts';
import {
  requireSessionType,
  resolveSessions,
} from '../middleware/auth.middleware.ts';
import {
  adminLoginLimiter,
  adminSessionLimiter,
  ipLimiter,
  metricsPollLimiter,
  redemptionsPollLimiter,
  attendeeSessionLimiter,
  staffSessionLimiter,
  whatsappPollLimiter,
} from '../middleware/rate.middleware.ts';
import {
  requireAdminScope,
  requireDrawPermission,
  requireRedeemPermission,
} from '../middleware/permission.middleware.ts';
import { normaliseBodyParserError } from '../middleware/body-parser-error.middleware.ts';
import { requireSupportedContentType } from '../middleware/content-type.middleware.ts';
import { rejectNulInput } from '../middleware/reject-nul.middleware.ts';
import { requireSameOrigin } from '../middleware/same-origin.middleware.ts';
import { errorHandler } from '../middleware/error.middleware.ts';
import { redisOutageToUnavailable } from '../middleware/redis-outage.middleware.ts';
import {
  checkinWindowGate,
  eventClosedGate,
} from '../middleware/landing.middleware.ts';
import { noStore } from '../middleware/no-store.middleware.ts';

const router = express.Router();

/**
 * The paths exempt from the per-IP tier.
 *
 * The pass endpoint is polled once per rotation window by every attendee with
 * their pass open. A venue puts the whole room behind one NAT address, so seven
 * hundred phones polling every thirty seconds is roughly 1,400 requests a
 * minute from a single `req.ip` — against a strict tier of 300. It would start
 * refusing at about 150 concurrent viewers, and it would refuse them at a
 * redemption counter.
 *
 * Exempting it costs little: the route sits behind `requireSessionType` and
 * `attendeeSessionLimiter`, which caps it at 30/min against a session ID that
 * cannot be minted without completing a check-in — itself rate-limited, and by
 * controls that do not key on IP. The per-IP tier was never the boundary here;
 * it was only the thing that would break first.
 *
 * **The front's status poll is exempt for the same reason, at the same rate.**
 * `/attendee/status` is polled every thirty seconds while the pass shows its front,
 * behind the same session check and session limiter, and a pass polls either
 * it or `/attendee/pass`, never both.
 *
 * **The exemption is earned by the session, not the path.** Both caps above
 * apply only to a session that resolves, so an anonymous request skips the
 * tier here provisionally and is charged to it after `resolveSessions`. An
 * anonymous flood is then bounded like any other path's, having paid for
 * the session lookups first.
 *
 * **The questionnaire's submit is exempt for the same reason, in one burst.**
 * An announcement in the room to fill it in sends everyone at once, from the
 * same address. It sits behind the same session check and session limiter,
 * and the schema accepts one response per attendee, so a flood from one
 * session is bounded twice over.
 *
 * **The receipt callback is exempt for the same reason and a sharper one.** A
 * 700-recipient run produces up to ~2,100 status events from a small set of
 * Meta addresses inside about twelve minutes, which trips a 300/60 tier — and
 * the `429` is not a refusal to Meta, it is a redelivery. Our own throttle
 * would cause the storm it was meant to bound. What bounds this path instead is
 * the signature, which is its actual boundary, plus the
 * `rl:ip:whatsapp-webhook` / `rl:global:whatsapp-webhook` pair sized for a run.
 */
const IP_LIMIT_EXEMPT = new Set([
  '/attendee/pass',
  '/attendee/status',
  '/survey',
]);

/** Prefix of the receipt callback, whose last segment is a secret. */
const WEBHOOK_PREFIX = '/whatsapp/webhook/';

// First, for the reason `adminPage()` mounts it on the web side: these bodies
// carry ticket codes, names, phone prefixes and credentials, and a response
// without a directive stays in the phone's disk cache. Blanket rather than per
// route, so a new endpoint cannot forget it. Ahead of the limiter, so a 429 and
// every refusal the error handler writes carry it too.
router.use(noStore);

router.use((req, res, next) => {
  if (IP_LIMIT_EXEMPT.has(req.path) || req.path.startsWith(WEBHOOK_PREFIX)) {
    return next();
  }

  ipLimiter(req, res, next);
});

// After the limiter, so a stream of unparseable requests still costs the
// sender their quota, and before every route, so it lands ahead of the Redis
// work in checkinSessionLimiter and requireCaptchaIfFlagged.
router.use(requireSupportedContentType);

// Same reasoning, and ahead of the parsers: a cross-site request should be
// refused before its body is read, not after.
//
// Not the receipt callback: Meta posts server to server, without an `Origin`,
// and the request carries no cookies for a forged page to ride on. The check
// has nothing to protect there, and the HMAC is its control.
router.use((req, res, next) => {
  if (req.path.startsWith(WEBHOOK_PREFIX)) return next();

  requireSameOrigin(req, res, next);
});

// Above the global parser, and that is the whole reason it is here rather than
// beside the other mounts. `express.json` below claims the body, and body-parser
// skips a request whose `req.body` is already set — so this route's own 4 KB
// limit would be silently inert anywhere further down. It still inherits
// `ipLimiter` and `requireSupportedContentType` from above.
//
// The one public write endpoint in the application. It carries its own two-tier
// budget rather than relying on `ipLimiter`: a bad deploy makes seven hundred
// phones report the same error at once, which is a disk problem rather than an
// abuse problem, and only a global cap answers it.
router.use('/client-errors', clientErrorRoutes);

// Above the global parser for a second, sharper reason: Meta signs the raw
// bytes, and a body this parser has already consumed cannot be re-serialised
// byte-identically. Mounted below, the signature could never be verified — and
// it would fail as an authentication bug rather than as a parse error.
//
// Gated on the switch, so a deployment that has not registered a callback does
// not carry a public inbound write at all. That is layer 10 of plan §7's table,
// and the first env-gated mount in this file; `server.ts` gates the runner the
// same way.
//
// The path's last segment is a secret, which is **noise reduction and not a
// control** — it takes the path out of opportunistic scanning, and the HMAC in
// `whatsapp.signature.ts` is what actually guards it. Nobody may skip the
// signature check because the path is hard to guess.
if (env.whatsapp.webhookEnabled) {
  router.use(
    `${WEBHOOK_PREFIX}${env.whatsapp.webhookPathSecret}`,
    whatsappWebhookRoutes,
  );
}

router.use(express.json({ limit: '10kb', inflate: false }));

// Immediately after the parsers, so it sees their failures and nothing else.
router.use(normaliseBodyParserError);

// Once the body is parsed and before anything reads it: a NUL that reaches
// Postgres is a 500 for what is the client's input.
router.use(rejectNulInput);

// Every attendee-facing mount, ahead of both the check-in gate and
// resolveSessions: after the event a refusal is all any of them owes, and it
// should cost nothing. The admin surface stays open for the teardown's exports.
router.use(
  ['/checkin', '/attendee', '/survey', '/staff', '/raffle'],
  eventClosedGate,
);

// Ahead of checkinRoutes so it lands before that router's own pacing limiter:
// a request made days early should cost the sender nothing but the refusal.
router.use('/checkin', checkinWindowGate, checkinRoutes);

router.use(resolveSessions);

// Charges the requests `IP_LIMIT_EXEMPT` let through provisionally but whose
// attendee session did not resolve. The same exact-path test as the skip, so a
// request is charged to the tier once or not at all; and the same condition
// `requireSessionType('attendee')` refuses on, so the exemption holds exactly
// for the requests those routes will serve.
router.use((req, res, next) => {
  if (IP_LIMIT_EXEMPT.has(req.path) && !req.sessions?.attendee) {
    ipLimiter(req, res, next);

    return;
  }

  next();
});

// Above the gated mount, and matched first because Express tries mounts in
// order: `requireSessionType('admin')` cannot guard the endpoint whose job is
// to issue the admin session. Its own limiter keys on IP, since there is no
// session to key on yet — see adminLoginLimiter.
//
// The limiter before the captcha, and the captcha before the router. The first
// so an IP flood is refused before it costs a siteverify call; the second
// because the service consumes the per-username failure budget up front, before
// it looks the account up, so a bot with nothing but a username could otherwise
// lock a volunteer out of their own account without solving anything.
router.use(
  '/admin/auth',
  adminLoginLimiter,
  requireAdminLoginCaptcha,
  adminAuthRoutes,
);

// Above the `/admin` mount, and that ordering is load-bearing rather than
// stylistic: Express tries mounts in the order they are registered, so a
// `/admin/metrics` registered below would match `/admin` first and inherit
// `adminSessionLimiter` — the 20/minute budget `metricsPollLimiter` exists to
// escape. `/admin/auth` above is the same shape for the same structural reason.
//
// It carries its own `requireSessionType('admin')` because it no longer
// inherits one, and the scope check lives on the route itself.
router.use(
  '/admin/metrics',
  requireSessionType('admin'),
  metricsPollLimiter,
  metricsRoutes,
);

// The WhatsApp sender's progress poll, above `/admin` for the same load-bearing
// reason as `/admin/metrics`: registered below, it would match `/admin` first
// and spend `adminSessionLimiter`'s 20/minute, which a three-second poll uses
// up on its own.
//
// An exact `get` rather than a `use` mount, and that is deliberate. The
// sender's writes live under `/admin/whatsapp/runs` too, and a `use` on that
// prefix would run this session check, this limiter and this scope check on
// every write before letting it fall through to `/admin` — charging each one
// to both budgets. Only the poll belongs here; the writes stay in
// `admin.routes.ts`.
router.get(
  '/admin/whatsapp/runs/current',
  requireSessionType('admin'),
  whatsappPollLimiter,
  requireAdminScope('whatsapp:send'),
  whatsappCurrentRun,
);

// The redemptions screen's totals poll, above `/admin` for the same reason as
// the two above. An exact `get`, like the sender's: the corrections live under
// `/admin/redemptions` too, and a `use` on that prefix would charge each of
// them to this limiter as well as to `adminSessionLimiter`.
router.get(
  '/admin/redemptions/summary',
  requireSessionType('admin'),
  redemptionsPollLimiter,
  requireAdminScope('redemptions:read'),
  redemptionsSummary,
);

router.use(
  '/admin',
  requireSessionType('admin'),
  adminSessionLimiter,
  adminRoutes,
);
router.use(
  '/attendee',
  requireSessionType('attendee'),
  attendeeSessionLimiter,
  attendeeRoutes,
);
router.use(
  '/survey',
  requireSessionType('attendee'),
  attendeeSessionLimiter,
  surveyRoutes,
);

// The staff surface runs on the volunteer's own attendee session — there is no
// separate staff login. `requireRedeemPermission` is what separates a volunteer
// who may redeem from one who may not, and it re-reads that from the database
// rather than trusting the session, so revoking someone does not have to wait
// out a 24-hour TTL.
router.use(
  '/staff',
  requireSessionType('attendee'),
  staffSessionLimiter,
  requireRedeemPermission,
  staffRoutes,
);

// The raffle runs on the volunteer's own attendee session too, gated on its own
// flag rather than on `can_redeem`: calling numbers from a stage and working a
// redemption counter are different jobs done by different people. Same limiter
// as the staff surface — the same handful of phones, at a lower rate.
router.use(
  '/raffle',
  requireSessionType('attendee'),
  staffSessionLimiter,
  requireDrawPermission,
  raffleRoutes,
);

// Before the handler, so it answers a Redis outage on any attendee-facing
// route with a 503 and a Retry-After; the admin routes are passed through.
router.use(redisOutageToUnavailable);

router.use(errorHandler);

export default router;
