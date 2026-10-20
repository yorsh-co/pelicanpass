import type { RequestHandler } from 'express';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';

import { env } from '../config/env.ts';

/**
 * The header Caddy's tailnet listener sets, and the public vhost strips.
 *
 * Trustworthy for the same reason the `Caddyfile` gives for preferring
 * `{client_ip}` over reading `CF-Connecting-IP` directly: the only peer that can
 * set it is a listener nothing else on the network can reach. The public vhost
 * removes any inbound copy before proxying, so a forged one never survives.
 */
const TAILNET_HEADER = 'x-admin-gate';

/** What Cloudflare Access puts the signed assertion in. */
const ASSERTION_HEADER = 'cf-access-jwt-assertion';

/** The only algorithm Cloudflare Access signs its assertions with. */
const ALGORITHMS = ['RS256'];

/**
 * The team's signing keys, resolved once.
 *
 * Module scope rather than per request, because the point of
 * `createRemoteJWKSet` is the cache: it fetches lazily on first use, keeps the
 * keys in memory and refetches only on rotation. In memory is also the only
 * option — the production container runs `read_only`.
 *
 * Built from configuration that may be absent, so it is created on first need
 * rather than at import: an unconfigured deployment must still boot.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** The issuer every token from this team carries. */
const issuer = (): string => `https://${env.cfAccess.teamDomain}`;

const keys = (): ReturnType<typeof createRemoteJWKSet> => {
  jwks ??= createRemoteJWKSet(new URL(`${issuer()}/cdn-cgi/access/certs`));

  return jwks;
};

/**
 * Verifies the Cloudflare Access assertion for every administrator path.
 *
 * **Why the origin checks this at all, when the edge already enforced a policy.**
 * Access binds that policy to a hostname and a path, at the edge, and nothing
 * about the arrangement is visible from here. A second public hostname on the
 * tunnel, or a mistyped path in the application definition, would open the whole
 * surface silently. Verifying the assertion ourselves inverts that: the edge
 * policy becomes the thing that stops strangers reaching a 403, rather than the
 * only thing stopping them reaching `/admin`.
 *
 * **`aud` is the check that matters on this team.** Anything else behind Access
 * on the same team domain — Tolgee, today — issues tokens with a valid signature
 * and a valid issuer. Only the audience tells them apart from ours.
 *
 * **Fails closed per request, not at boot.** While either configuration value is
 * unset there is nothing to verify against, and every request that did not
 * arrive over the tailnet is refused. That is the state the gate deploys in,
 * before the Access application exists. A boot-time check could not do this job:
 * the app cannot see whether Caddy has opened the public path.
 *
 * Answers a bare 403 rather than a rendered page. This is mounted above the web
 * router, so `localeMiddleware` has not run and `res.locals.chrome` is still the
 * base-locale default — a rendered error view would come out unlocalised.
 */
export const requireAccessAssertion: RequestHandler = async (
  req,
  res,
  next,
) => {
  // The tailnet listener vouches for the request, so there is no assertion to
  // check and nothing to fetch keys for.
  if (req.get(TAILNET_HEADER) === 'tailnet') return next();

  const { teamDomain, aud } = env.cfAccess;

  if (!teamDomain || !aud) {
    req.log.warn('Access assertion unverifiable: CF_ACCESS_* not configured');

    res.sendStatus(403);

    return;
  }

  const token = req.get(ASSERTION_HEADER);

  if (!token) {
    req.log.warn('Access assertion missing');

    res.sendStatus(403);

    return;
  }

  try {
    // Cloudflare always sets `kid`. Without it jose would try every key in the
    // set, so a token naming no key is refused rather than matched by trial.
    if (!decodeProtectedHeader(token).kid) {
      req.log.warn('Access assertion rejected: no kid');

      res.sendStatus(403);

      return;
    }

    await jwtVerify(token, keys(), {
      issuer: issuer(),
      audience: aud,
      algorithms: ALGORITHMS,
    });

    next();
  } catch (err) {
    // Neither the token (a bearer credential until it expires) nor jose's
    // `payload` on the error (the user's email) is logged: only what names the
    // failure.
    const { code, claim } = err as { code?: unknown; claim?: unknown };

    req.log.warn({ code, claim }, 'Access assertion rejected');

    res.sendStatus(403);
  }
};
