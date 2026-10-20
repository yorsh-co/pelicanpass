import type { Request, RequestHandler } from 'express';

import { ForbiddenError } from '../shared/errors/app-error.ts';
import { maskUrlSecrets } from '../shared/utils/mask.ts';
import { env } from '../config/env.ts';

/**
 * Origins this deployment answers for, derived once at load.
 *
 * `URL` normalises what `APP_URL` and `ADMIN_URL` may carry — a trailing slash,
 * a path, a default port — down to the scheme-host-port triple a browser actually
 * sends in `Origin`, so the comparison below is string equality rather than a set
 * of near-miss cases.
 *
 * @throws {TypeError} At module load, if `APP_URL` or `ADMIN_URL` is not a valid
 *   absolute URL. Deliberate: a typo here would otherwise make every state-changing
 *   request 403 at the door, and boot is the cheapest place to find that out.
 */
const APP_ORIGINS = new Set(
  [env.appUrl, env.adminUrl]
    .filter((url) => url !== '')
    .map((url) => new URL(url).origin),
);

/** Methods that cannot change state, so cannot be the target of CSRF. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a `null` origin is one of our own form posts rather than a forged one.
 *
 * Helmet's default `Referrer-Policy: no-referrer` makes a navigation — which is
 * what an HTML form post is — serialise its origin as the literal string `null`
 * (Fetch, "append a request `Origin` header"). The branch that keeps the real
 * origin is taken only by mode `cors`, so every `fetch` is unaffected and every
 * `<form method="post">` on the administrator surface is not.
 *
 * `Sec-Fetch-Site` is what separates ours from an attacker's, and the referrer
 * policy cannot be used to dodge it: a page cannot set it — the browser derives
 * it from the initiator — so a cross-site post reports `cross-site` whatever
 * policy it chose. An opaque initiator, a sandboxed frame or a `data:` document,
 * is same-origin with nothing and reports `cross-site` as well.
 *
 * Forgeable outside a browser: a client that can set the header can equally
 * send `Sec-Fetch-Site: same-origin` with no `Origin`, which passes below. The
 * check defends against a victim's browser, not against a scripted client.
 *
 * @param req - The request being validated.
 * @returns Whether the pair of headers can only have come from our own page.
 */
const isSameOriginNavigation = (req: Request): boolean =>
  req.headers.origin === 'null' &&
  req.headers['sec-fetch-site'] === 'same-origin';

/**
 * Rejects a state-changing request that does not declare an origin of ours.
 *
 * `sameSite: 'lax'` is the primary CSRF control. This closes its one documented
 * hole: Chrome's "Lax + POST" grace period exempts cookies younger than two
 * minutes on a top-level cross-site POST, and check-in cookies are minted at
 * the door and used seconds later.
 *
 * **Required, with one exception.** Browsers send `Origin` on every POST, so a
 * cross-site form post cannot omit it, and a request with none is not from a
 * browser page. It is admitted only when `Sec-Fetch-Site: same-origin` says the
 * browser itself initiated it from our own origin. Non-browser clients (`curl`,
 * Node's `fetch`, k6) must send `Origin` equal to the deployment's origin.
 *
 * **Present and `null` is not the same as cross-origin.** A same-origin form
 * post arrives that way under the referrer policy this application sets, so it
 * is admitted on the corroborating header `isSameOriginNavigation` reads. Every
 * other `null` — including the one an attacker gets by declaring `no-referrer`
 * on their own page — is refused.
 */
export const requireSameOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const { origin } = req.headers;

  const allowed =
    origin === undefined
      ? req.headers['sec-fetch-site'] === 'same-origin'
      : APP_ORIGINS.has(origin) || isSameOriginNavigation(req);

  if (!allowed) {
    req.log.warn(
      { origin, method: req.method, path: maskUrlSecrets(req.originalUrl) },
      'Cross-origin request rejected',
    );

    return next(new ForbiddenError());
  }

  next();
};
