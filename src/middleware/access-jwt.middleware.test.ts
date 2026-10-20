import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { env } from '../config/env.ts';

import { requireAccessAssertion } from './access-jwt.middleware.ts';

import type { Request, Response } from 'express';
import type { CryptoKey, JWK } from 'jose';

const TEAM = 'team.cloudflareaccess.test';
const AUD = 'application-aud';
const EMAIL = 'someone@example.test';
const KID = 'key-1';

interface Signer {
  key: CryptoKey;
  alg: string;
}

let rs256: Signer;
let hs256Secret: Uint8Array;
let es256: Signer;
let realFetch: typeof fetch;

/** Generates an asymmetric signing pair for `alg`. */
const pair = async (alg: string): Promise<Signer & { jwk: JWK }> => {
  const { privateKey, publicKey } = await generateKeyPair(alg);

  return {
    key: privateKey,
    alg,
    jwk: { ...(await exportJWK(publicKey)), kid: KID, alg, use: 'sig' },
  };
};

before(async () => {
  const rsa = await pair('RS256');

  rs256 = rsa;
  es256 = await pair('ES256');
  hs256Secret = new TextEncoder().encode('x'.repeat(32));

  env.cfAccess.teamDomain = TEAM;
  env.cfAccess.aud = AUD;

  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();

    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [rsa.jwk] });
    }

    return realFetch(input, init);
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

/** Builds a token with the usual claims, signed by `key`. */
const sign = (
  key: CryptoKey | Uint8Array,
  header: { alg: string; kid?: string },
  expiresAt: number | string = '5m',
): Promise<string> =>
  new SignJWT({ email: EMAIL, type: 'app' })
    .setProtectedHeader(header)
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
    .setExpirationTime(expiresAt)
    .sign(key);

/** Runs the gate with an assertion header and reports the outcome. */
const run = async (
  token: string,
): Promise<{ status?: number; passed: boolean; logged: string }> => {
  const logged: unknown[] = [];
  const outcome: { status?: number; passed: boolean } = { passed: false };

  const req = {
    get: (name: string) =>
      name === 'cf-access-jwt-assertion' ? token : undefined,
    log: { warn: (...args: unknown[]) => logged.push(args) },
  } as unknown as Request;
  const res = {
    sendStatus: (status: number) => {
      outcome.status = status;
    },
  } as unknown as Response;

  await requireAccessAssertion(req, res, () => {
    outcome.passed = true;
  });

  return { ...outcome, logged: JSON.stringify(logged) };
};

describe('requireAccessAssertion', () => {
  it('accepts an RS256 token carrying a kid', async () => {
    const result = await run(await sign(rs256.key, { alg: 'RS256', kid: KID }));

    assert.equal(result.passed, true);
  });

  it('refuses a validly signed token with no kid', async () => {
    const result = await run(await sign(rs256.key, { alg: 'RS256' }));

    assert.equal(result.passed, false);
    assert.equal(result.status, 403);
  });

  it('refuses a token whose protected header is malformed', async () => {
    const result = await run('not-a-jwt');

    assert.equal(result.passed, false);
    assert.equal(result.status, 403);
  });

  it('refuses an ES256 token', async () => {
    const result = await run(await sign(es256.key, { alg: 'ES256', kid: KID }));

    assert.equal(result.passed, false);
    assert.equal(result.status, 403);
  });

  it('refuses an HS256 token', async () => {
    const result = await run(
      await sign(hs256Secret, { alg: 'HS256', kid: KID }),
    );

    assert.equal(result.passed, false);
    assert.equal(result.status, 403);
  });

  it('logs a rejected assertion without its claims', async () => {
    const result = await run(
      await sign(
        rs256.key,
        { alg: 'RS256', kid: KID },
        Math.floor(Date.now() / 1000) - 60,
      ),
    );

    assert.equal(result.status, 403);
    assert.ok(result.logged.includes('ERR_JWT_EXPIRED'), result.logged);
    assert.ok(!result.logged.includes(EMAIL), result.logged);
    assert.ok(!result.logged.includes('payload'), result.logged);
  });
});
