import { logger } from '../../modules/log/logger.ts';
import {
  noteRequestSucceeded,
  raiseChallengeGate,
} from '../../modules/ui/challenge-gate.ts';
import { reportError } from '../telemetry/report-error.ts';
import { ApiError } from './api.error.ts';
import type { ApiErrorCode, ApiErrorDetails } from './api.error.ts';

/**
 * The error envelope the backend's `errorHandler` serialises. Only read on a
 * non-ok response, and every member is optional because a proxy or a crash can
 * put something else on the wire entirely.
 */
interface ApiErrorBody {
  error?: string;
  code?: ApiErrorCode;
  details?: ApiErrorDetails;
}

/**
 * Error code for a failure the backend did not produce.
 *
 * Cloudflare answers a challenge, a block or its own rate limiting with HTML,
 * so `res.json()` throws and there is no `code` to read.
 *
 * `cf-mitigated: challenge` is set by Cloudflare precisely so that XHR callers
 * can recognise a challenge they have no way to render: a `fetch` never
 * displays the interstitial, so there is nothing on screen for the attendee to
 * solve.
 *
 * This once reported `RATE_LIMITED`, on the reasoning that the only way through
 * was to wait the window out. That is true of a *throttle* — the geo gate in
 * `docs/infrastructure/cloudflare-rules.md` — and false of the case that actually reaches
 * attendees: the zone's Challenge Passage lapsing, which no amount of waiting
 * mends. The two need opposite remedies, so they get separate codes, and
 * `EDGE_CHALLENGE` carries the one that works. See {@link raiseChallengeGate}.
 *
 * A 429 with no `cf-mitigated` is Cloudflare's own rate limiting, where waiting
 * genuinely is the remedy, so that branch keeps `RATE_LIMITED`.
 *
 * @param res - Response whose body did not parse as the error envelope.
 * @returns A code to report, or undefined to leave it as `UNKNOWN_ERROR`.
 */
const edgeErrorCode = (res: Response): ApiErrorCode | undefined => {
  if (res.headers.get('cf-mitigated') === 'challenge') return 'EDGE_CHALLENGE';

  if (res.status === 429) return 'RATE_LIMITED';

  return undefined;
};

/**
 * How long a request may take, headers and body together, before the client
 * gives up and reports `EDGE_TIMEOUT`.
 *
 * Well below Cloudflare's 100-second origin timeout, which is the only other
 * bound on the way and far longer than anyone at a door will look at a
 * spinner.
 *
 * Deliberately **not** above every server path. The server's bounds add up
 * along one request: a captcha'd ticket submit can spend 5 s waiting for a
 * pool connection, 10 s on `siteverify` and 5 s on a statement. Those steps are
 * safe to repeat, so giving up first costs a re-tap, not a duplicate.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Options for {@link request}: `fetch`'s own, with `body` replaced by `json`. */
export interface RequestOptions extends Omit<RequestInit, 'body' | 'signal'> {
  /** Serialised as the request body, with the JSON Content-Type set. */
  json?: unknown;

  /**
   * Overrides {@link REQUEST_TIMEOUT_MS}, for an endpoint that legitimately
   * waits on something slower than the database.
   */
  timeoutMs?: number;
}

/**
 * Builds a timeout failure for `path`, logging it on the way out.
 *
 * No `status`, as with `EDGE_UNREACHABLE`: whatever did or did not answer, the
 * client stopped listening before it could say.
 *
 * @param path - Request path that timed out.
 * @returns The error to throw.
 */
const timeoutFailure = (path: string): ApiError => {
  const err = new ApiError('Request timed out', { code: 'EDGE_TIMEOUT' });

  logApiFailure(path, err);

  return err;
};

/**
 * One request, start to finish, under a signal {@link request} owns.
 *
 * @param path - Absolute request path.
 * @param options - Passed through to `fetch`, except for `json`.
 * @param signal - Aborts the request when the deadline passes.
 * @param timedOut - Whether that abort was the deadline's, read at the moment
 *   a failure is caught.
 * @throws {ApiError} On a non-2xx response, a 2xx body that is not JSON, or
 *   the deadline.
 */
const send = async <T>(
  path: string,
  options: Omit<RequestOptions, 'timeoutMs'>,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<T> => {
  const { json, ...rest } = options;

  const init: RequestInit = { credentials: 'include', ...rest, signal };

  if (json !== undefined) {
    // Built through Headers rather than spread: HeadersInit is also satisfied
    // by an entry array and by a Headers instance, neither of which spreads
    // into an object as callers would expect.
    const headers = new Headers(rest.headers);
    headers.set('Content-Type', 'application/json');

    init.body = JSON.stringify(json);
    init.headers = headers;
  }

  let res: Response;

  try {
    res = await fetch(path, init);
  } catch {
    // Checked first: a deadline abort rejects the same way a dropped connection
    // does, and must not reach the challenge gate below. A slow server is not
    // an expired session.
    if (timedOut()) throw timeoutFailure(path);

    // Wrapped rather than left to propagate. A rejection here is a request that
    // never completed, and the two things that cause it on this surface are an
    // expired Access session — whose redirect to the team domain is cross-origin
    // with no CORS headers — and a phone losing signal. Both arrive as a bare
    // `TypeError`, which is not an `ApiError`, so it would bypass the reporting
    // suppression and be filed as a client defect.
    //
    // No `status`: nothing answered, and a number here would imply something did.
    // The rejection itself is dropped — the browser's message for both cases is
    // the same unhelpful "Failed to fetch".
    const err = new ApiError('Request did not complete', {
      code: 'EDGE_UNREACHABLE',
    });

    logApiFailure(path, err);

    // Only the administrator surface, and only when the browser believes it is
    // online. Offline is the likelier cause at a door, and covering the page with
    // "sign in again" would be a worse lie than saying nothing — the button would
    // land them on the browser's offline page. Left to throw, each screen shows
    // the failure it already shows.
    if (path.startsWith('/api/v1/admin') && window.navigator.onLine) {
      raiseChallengeGate({ cause: 'access' });
    }

    throw err;
  }

  // Anything that answered at all proves the clearance is current, so the
  // challenge gate can forget whatever it was counting.
  if (res.ok) noteRequestSucceeded();

  // A 204 carries no body, so res.json() would reject and be misread as a
  // malformed response. Endpoints that answer 204 declare `T` as `undefined`.
  if (res.ok && res.status === 204) return undefined as T;

  let data: unknown;
  let isJson = true;

  try {
    data = await res.json();
  } catch {
    // The body stream shares the request's signal, so a body that stalls after
    // the headers is cut off by the same deadline. That is not a malformed
    // response.
    if (timedOut()) throw timeoutFailure(path);

    isJson = false;
  }

  if (res.ok) {
    if (!isJson)
      throw new ApiError('Invalid server response', {
        status: res.status,
      });

    return data as T;
  }

  const body = isJson ? (data as ApiErrorBody) : {};

  const err = new ApiError(body.error ?? 'Request failed', {
    status: res.status,
    code: body.code ?? edgeErrorCode(res),
    details: body.details,
  });

  logApiFailure(path, err);

  // A UI side effect in the transport layer, taken deliberately. This is the
  // only function in the client that calls `fetch`, so handling the challenge
  // here is the one place no page, step or copy table can miss it; branching in
  // the dozen call sites instead means a single omission silently restores the
  // dead end. The error still throws, so callers are unchanged.
  if (err.code === 'EDGE_CHALLENGE') raiseChallengeGate();

  // Same reasoning: the event has closed, and the reload lands on the closing
  // page, which makes no API calls, so this cannot loop.
  if (err.code === 'EVENT_CLOSED') window.location.reload();

  throw err;
};

/**
 * Shared fetch wrapper for API calls. Parses the JSON body and, on a
 * non-ok response, throws an ApiError carrying the server's `code`
 * and `details` so callers can branch on error type.
 *
 * The parsed body is returned as `unknown` unless the caller names a type.
 *
 * Every request carries a deadline. The abort is told apart from any other
 * rejection by a flag the timer sets, not by the error it produces: Safari
 * before 15.4 ignores an abort reason and rejects with a plain `AbortError`,
 * and the attendee surface still serves phones that old.
 *
 * @param path - Absolute request path.
 * @param options - Passed through to `fetch`, except for `json` and
 *   `timeoutMs`.
 * @throws {ApiError} On a non-2xx response, a 2xx body that is not JSON, or
 *   `EDGE_TIMEOUT` when the deadline passes first.
 */
export const request = async <T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> => {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = options;

  const controller = new AbortController();
  let timedOut = false;

  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await send<T>(path, rest, controller.signal, () => timedOut);
  } finally {
    // Every exit, including the body read, so a stalled body stays bounded and
    // a settled request leaves nothing behind to abort.
    window.clearTimeout(timer);
  }
};

const ROUTINE_ERROR_CODES = new Set<ApiErrorCode>([
  'VALIDATION_ERROR',
  'CAPTCHA_REQUIRED',
  // A lapsed Access session or a lost signal, either of which a polling
  // dashboard would otherwise log at `warn` every five seconds.
  'EDGE_UNREACHABLE',
  // The same polling dashboard against a slow server or a stalled network.
  'EDGE_TIMEOUT',
]);

/**
 * Logs an API-related error at an appropriate level: ApiErrors
 * (expected 4xx failures) at 'warn' with their code/status, anything
 * else (unexpected bugs) at 'error' with the stack trace.
 *
 * @param path - Request path the error came from.
 * @param err - The thrown error.
 */
const logApiFailure = (path: string, err: Error): void => {
  if (err instanceof ApiError) {
    const level = ROUTINE_ERROR_CODES.has(err.code) ? 'debug' : 'warn';
    logger[level]('api', err.message, {
      path,
      code: err.code,
      status: err.status,
    });
  } else {
    logger.error('api', err.message, { path, stack: err.stack });
  }

  // The single place every API failure passes through, which is why the hook is
  // here rather than at the dozen call sites. `reportError` decides what is
  // worth sending — it drops the codes the interface already has screens for,
  // so a mistyped ticket code stays a mistyped ticket code and does not become
  // telemetry.
  reportError(err);
};
