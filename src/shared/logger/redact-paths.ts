/**
 * Field paths Pino censors on every log line, regardless of which module
 * emitted it.
 *
 * Body field names must match what the controllers actually read
 * (checkin.controller.ts): `ticket`, `verificationCode`, `qrCode`,
 * `captchaToken`. The list previously named `ticketCode` and `qrToken`,
 * neither of which is a field any request carries, so `req.body.ticket` was
 * not redacted. Moot while the `req` serializer omits the body entirely —
 * which is exactly why it went unnoticed and would have failed silently the
 * first time anyone logged one.
 *
 * Shared rather than inlined into the logger so that anything else writing a
 * record derived from a request censors the same fields. A second list would
 * drift, and the drift would be invisible until it mattered.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  "res.headers['set-cookie']",
  'req.headers.authorization',
  'req.body.captchaToken',
  'req.body.verificationCode',
  'req.body.ticket',
  'req.body.qrCode',
  // The published notice promises the operation logs carry no nickname.
  'req.body.nickname',

  // The pass token, and the review handle a verify hands back. Both are
  // bearer credentials for as long as they live, and both arrive in a body
  // on the staff surface.
  'req.body.token',
  'req.body.handle',

  // `/staff/lookup` takes a ticket code, and `req.body.ticket` above is
  // redacted for exactly that reason. A credential does not stop being one
  // because it arrived under a different field name.
  'req.body.query',

  // The administrator roster and the volunteer lookup search on `q`, which
  // is matched against the name, the nickname, the ticket code and the
  // phone digits. It used to arrive in a query string, where
  // `maskUrlSecrets` caught it; it arrives in a body now, so its cover
  // moved here with it. Moot today for the reason noted above — the `req`
  // serializer omits the body — and listed for the same reason the four
  // check-in fields are. The filters beside it (`role`, `checkin`,
  // `archived`, `page`) name nobody and stay readable.
  'req.body.q',

  // The WhatsApp sender's test send takes a typed phone number, and the
  // published notice promises the operation logs carry none. Listed for the
  // same reason as the fields above: the serializer omits the body today.
  'req.body.phone',

  // Questionnaire answers are anonymous only if nothing records them beside
  // the request that carried them, and the request log names the attendee.
  // Listed for the same reason as the fields above: the serializer omits the
  // body today.
  'req.body.answers',

  // Meta signs every webhook body with this header, and it is the whole
  // boundary on that route. Listed before the route exists for the same reason
  // the check-in body fields above are listed: the serializer that would expose
  // it is one change away, and a redaction added after the leak is not a
  // control.
  "req.headers['x-hub-signature-256']",

  // The Cloudflare Access assertion is a signed bearer credential for every
  // administrator path until it expires, and its payload names the user.
  // Listed for the same reason as the signature header above: the serializer
  // that would expose it is one change away.
  "req.headers['cf-access-jwt-assertion']",

  // Postgres puts row values in an error's `detail` — "Failing row contains
  // (…)", "Key (…)=(…) already exists" — and can quote a statement, values
  // included, in `where` and `internalQuery`. pino's `err` serializer copies
  // all three, so any `log.*({ err })` a query failure reaches would write a
  // name or a phone number, which the published notice promises the logs never
  // carry. Redaction runs on the serialized error. `code`, `constraint`,
  // `table` and `column` name the schema rather than a row and stay readable.
  'err.detail',
  'err.where',
  'err.internalQuery',

  // A pool error raised when Postgres terminates a connection (57P01) carries
  // the whole `pg` Client as `err.client`: connection parameters and internal
  // state, including `secretKey`, the cancel key of the backend connection.
  // pino's `err` serializer copies it, and the key would reach stdout and the
  // durable log file. Redaction runs on the serialized error. Applies to every
  // `log.*({ err })`, not only the pool's error handler.
  'err.client',

  // Not request paths — these are top-level leaves, and nothing logs them
  // today. They are here as a backstop against a future `log.info({ token })`
  // or a config object reaching a log line, which is the failure this file
  // cannot otherwise reach: every other entry describes a shape the logger
  // already produces, and these describe one it must never start producing.
  'accessToken',
  'appSecret',
  'webhookVerifyToken',
  'webhookPathSecret',
];

/**
 * Field names that must never leave the host inside an alert.
 *
 * Compared lower-cased by `scrub`. Covers the cookie, authorization and
 * request-body leaves of {@link REDACT_PATHS}, plus values that do not appear
 * in a log line today but would be just as wrong in a Discord message — `name`
 * and `phone` are read from the database rather than a request body, so the
 * redaction list above never needed them. It is not a full mirror: the
 * signature header, the `err` leaves and the secret leaves are absent.
 *
 * Enforced at the egress boundary in `telemetry/alerts.ts` rather than trusted
 * to each call site. A denylist that depends on every future caller
 * remembering it is not a control.
 */
export const ALERT_FORBIDDEN_FIELDS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'captchatoken',
  'verificationcode',
  'ticket',
  'ticketcode',
  'qrcode',
  'nickname',
  'token',
  'handle',
  'query',
  'q',
  'name',
  'attendeename',
  'firstname',
  'lastname',
  'phone',
  'phonestart',
  'username',
  'answers',
]);
