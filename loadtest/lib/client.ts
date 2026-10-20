/**
 * One synthetic phone: its address, its cookies, and the requests it makes.
 *
 * Cookies are carried by hand rather than by k6's jar. Under
 * `NODE_ENV=production` every session cookie is `Secure`, and the jar
 * (rightly) will not send a `Secure` cookie over the plain HTTP this test
 * speaks to app:3000. Redirects are followed by hand for the same reason, and
 * so each hop is charged to the limiters exactly as a browser's would be.
 */

import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

import { settings } from './config.ts';

import type { RefinedResponse, ResponseType } from 'k6/http';

type Response = RefinedResponse<ResponseType | undefined>;

/** Whether a request is part of the measured run or of `setup()`. */
export type Stage = 'load' | 'setup';

/** Share of measured requests answered 429. The run's main verdict. */
export const rateLimited = new Rate('rate_limited');

/**
 * Share of measured requests answered 5xx, sheds aside. Kept apart from
 * `http_req_failed`, which also counts the 4xx a mistyped ticket is meant to
 * get.
 */
export const serverErrors = new Rate('server_errors');

/**
 * Share of measured requests the app turned away to protect itself. No
 * threshold: above capacity it is meant to rise.
 */
export const shed = new Rate('shed');

/**
 * Duration of every measured request that was not shed, static files
 * included. Stands in for `http_req_duration`, which cannot drop a request
 * after the fact: a shed answers in about a millisecond, and counting it would
 * read an overload as fast service.
 */
export const servedDuration = new Trend('served_duration', true);

/** Measured requests refused with `CAPTCHA_REQUIRED`. */
export const captchaRequired = new Counter('captcha_required');

/** Longest redirect chain followed. The entry link takes one hop. */
const MAX_REDIRECTS = 5;

/**
 * The target's origin, sent as `Origin` on every state-changing request: the
 * app refuses one that names none. `compose.loadtest.yml` sets the
 * target's `APP_URL` to match.
 */
const ORIGIN =
  /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i.exec(settings.baseUrl)?.[0] ?? '';

/** A refusal a flow could not recover from; its steps stop there. */
export class FlowError extends Error {
  readonly response: Response;

  constructor(step: string, response: Response) {
    super(`${step} answered ${String(response.status)}`);
    this.name = 'FlowError';
    this.response = response;
  }
}

export class Person {
  readonly ip: string;

  readonly stage: Stage;

  readonly #cookies = new Map<string, string>();

  /**
   * @param ip - Address presented as `X-Forwarded-For`.
   * @param stage - Which stage the requests are measured under.
   */
  constructor(ip: string, stage: Stage) {
    this.ip = ip;
    this.stage = stage;
  }

  /** The attendee session ID, once check-in has issued one. */
  get attendeeSession(): string | undefined {
    return this.#cookies.get('attendee_session_id');
  }

  /**
   * Adopts a session minted elsewhere, as a second tab of the same phone.
   *
   * @param sessionId - An `attendee_session_id` value.
   */
  useAttendeeSession(sessionId: string): void {
    this.#cookies.set('attendee_session_id', sessionId);
  }

  /**
   * Loads a page, following redirects, as a navigation would.
   *
   * @param path - Path and query.
   * @param name - Metric name for the path, so tokens do not split series.
   */
  get(path: string, name: string = path): Response {
    let res = this.#send('GET', path, null, name);

    for (let hop = 0; hop < MAX_REDIRECTS && isRedirect(res.status); hop++) {
      const location = res.headers.Location ?? res.headers.location;

      if (!location) break;

      res = this.#send(
        'GET',
        location,
        null,
        location.split('?')[0] ?? location,
      );
    }

    return res;
  }

  /**
   * Calls a JSON API route.
   *
   * @param method - HTTP method.
   * @param path - Path under the origin.
   * @param body - Serialised as JSON when present.
   */
  api(method: 'GET' | 'POST', path: string, body?: unknown): Response {
    return this.#send(
      method,
      path,
      body === undefined ? null : JSON.stringify(body),
      path,
    );
  }

  /**
   * Fetches what a first page view pulls in: stylesheets and scripts.
   *
   * Static files are served before every limiter, so they cost CPU and
   * nothing else.
   *
   * @param page - The rendered page.
   */
  assets(page: Response): void {
    if (!settings.assets || typeof page.body !== 'string') return;

    const doc = page.html();

    const urls = [
      ...doc
        .find('link[rel="stylesheet"][href]')
        .toArray()
        .map((e) => e.attr('href')),
      ...doc
        .find('script[src]')
        .toArray()
        .map((e) => e.attr('src')),
    ].filter(
      (url): url is string => typeof url === 'string' && url.startsWith('/'),
    );

    if (urls.length === 0) return;

    const responses = http.batch(
      urls.map((url) => ({
        method: 'GET',
        url: `${settings.baseUrl}${url}`,
        params: this.#params('static', false),
      })),
    );

    // Static files are mounted ahead of the load-shedding middleware, so none
    // of these is ever a shed.
    if (this.stage === 'load') {
      for (const res of responses) {
        servedDuration.add(res.timings.duration, { name: 'static' });
      }
    }
  }

  #send(
    method: string,
    path: string,
    body: string | null,
    name: string,
  ): Response {
    const url = path.startsWith('http') ? path : `${settings.baseUrl}${path}`;

    const res = http.request(method, url, body, {
      ...this.#params(name, body !== null, method),
      redirects: 0,
    });

    this.#store(res);

    if (this.stage === 'load') {
      const wasShed = isShed(res);

      rateLimited.add(res.status === 429);
      shed.add(wasShed);
      serverErrors.add(res.status >= 500 && !wasShed);

      if (!wasShed) servedDuration.add(res.timings.duration, { name });

      if (errorCode(res) === 'CAPTCHA_REQUIRED') captchaRequired.add(1);
    }

    return res;
  }

  #params(name: string, json: boolean, method = 'GET') {
    const headers: Record<string, string> = { 'X-Forwarded-For': this.ip };

    const cookie = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');

    if (cookie) headers.Cookie = cookie;
    if (json) headers['Content-Type'] = 'application/json';

    // The app refuses a state-changing request that names no origin of its own.
    if (method !== 'GET') headers.Origin = ORIGIN;

    return {
      headers,
      // A fresh jar per request keeps k6 from sending a second copy of the
      // cookies above when they are not `Secure` (a non-production stack).
      jar: new http.CookieJar(),
      tags: { name, stage: this.stage },
    };
  }

  #store(res: Response): void {
    for (const [name, list] of Object.entries(res.cookies)) {
      const last = list[list.length - 1];

      if (!last) continue;

      // `clearCookie` answers an empty value with an expiry in the past.
      if (last.value === '') this.#cookies.delete(name);
      else this.#cookies.set(name, last.value);
    }
  }
}

/**
 * Reads the `code` of a JSON answer, or undefined for anything else.
 *
 * @param res - Any response.
 */
export const errorCode = (res: Response): string | undefined => {
  const type = res.headers['Content-Type'] ?? '';

  if (!type.includes('application/json')) return undefined;

  try {
    const parsed = res.json() as { code?: unknown } | null;

    return typeof parsed?.code === 'string' ? parsed.code : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether the app turned a request away under load rather than failing it.
 *
 * A `503` with `Retry-After` is the load-shedding middleware's answer and
 * nothing else's: `/readyz` answers `503` without the header, and is not
 * requested here anyway. Read off the status and header rather than the body,
 * so the HTML busy page counts as well as the JSON envelope.
 *
 * @param res - Any response.
 */
export const isShed = (res: Response): boolean =>
  res.status === 503 && res.headers['Retry-After'] !== undefined;

const isRedirect = (status: number): boolean => status >= 300 && status < 400;
