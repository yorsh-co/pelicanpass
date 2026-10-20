import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { pinoHttp } from 'pino-http';
import type { StdSerializedResults } from 'pino-http';

import { logger } from '../shared/logger/logger.ts';
import { maskUrlSecrets } from '../shared/utils/mask.ts';

/**
 * What a custom serializer actually receives.
 *
 * pino-http defaults to `wrapSerializers: true`, so serializers are handed the
 * output of pino-std-serializers rather than the request itself. That object
 * carries `headers`, `method`, `url` and `id`, but none of Express's
 * additions — which is why the client IP is set through `customProps` below.
 */
type SerializedRequest = StdSerializedResults['req'];
type SerializedResponse = StdSerializedResults['res'];

/**
 * Request-scoped HTTP logger. Attaches `req.log` (a Pino child logger
 * bound to a request id) to every request, and logs one line per
 * completed request. The request id is echoed back via `X-Request-Id`
 * so it can be correlated with a client-reported issue.
 */
/**
 * Shape a client-supplied request ID has to match to be accepted.
 *
 * The value is reflected in a response header and used as the log correlation
 * ID, so it is attacker-controlled output on two paths. Unvalidated, a client
 * could reflect a 100KB header back at itself, or deliberately collide its IDs
 * with a victim's to make log correlation useless.
 *
 * Bounded to what an ID legitimately is: UUIDs and the hex/slug forms tracing
 * tools emit, and nothing that could be mistaken for markup or a header
 * separator.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Level of a request's completion line.
 *
 * A shed 503 is a deliberate refusal. At `error` it would bury the real
 * failures under thousands of lines during exactly the minute that matters. A
 * 503 for an unreachable dependency is the same: the dependency's own probe
 * reports the outage, and one `error` line per request would repeat it for
 * every attendee at the door.
 *
 * @param res - The finished response.
 * @param err - The error pino-http saw, if any.
 */
export const requestLogLevel = (
  res: { statusCode: number; locals: Record<string, unknown> },
  err?: Error,
): 'info' | 'warn' | 'error' => {
  if (res.locals.shed || res.locals.degraded) return 'warn';
  if (err || res.statusCode >= 500) return 'error';
  if (res.statusCode >= 400) return 'warn';

  return 'info';
};

export const httpLogger = pinoHttp<Request, Response>({
  logger,
  genReqId: (req, res) => {
    const existingId = req.headers['x-request-id'];

    // A client may send the header more than once, which Node surfaces as an
    // array. Take the first so the id stays a single value.
    const supplied = Array.isArray(existingId) ? existingId[0] : existingId;

    // A malformed id is replaced rather than rejected: the caller loses their
    // correlation id, which is theirs to lose, and the request proceeds.
    const id =
      supplied !== undefined && REQUEST_ID_RE.test(supplied)
        ? supplied
        : randomUUID();

    res.setHeader('X-Request-Id', id);

    return id;
  },
  customLogLevel: (_req, res, err) => requestLogLevel(res, err),
  // Unlike serializers, customProps receives the Express request, so `req.ip`
  // is the address Express resolved through `trust proxy`.
  customProps: (req) => ({
    ip: req.ip,
  }),
  serializers: {
    req: (req: SerializedRequest) => ({
      id: req.id,
      method: req.method,
      url: maskUrlSecrets(req.url),
      xff: req.headers['x-forwarded-for'],
      cfIp: req.headers['cf-connecting-ip'],
      country: req.headers['cf-ipcountry'],
      userAgent: req.headers['user-agent'],
    }),
    res: (res: SerializedResponse) => ({
      statusCode: res.statusCode,
    }),
  },
});
