import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { env } from '../config/env.ts';
import { ForbiddenError } from '../shared/errors/app-error.ts';

import { requireSameOrigin } from './same-origin.middleware.ts';

import type { Request } from 'express';

const APP_ORIGIN = new URL(env.appUrl).origin;

/** Runs the check and reports whether the request was let through. */
const passes = (
  method: string,
  headers: Record<string, string> = {},
): boolean => {
  const req = {
    method,
    headers,
    originalUrl: '/api/v1/x',
    log: { warn: () => undefined },
  } as unknown as Request;
  let error: unknown;
  let called = false;

  requireSameOrigin(req, {} as never, (err?: unknown) => {
    called = true;
    error = err;
  });

  assert.ok(called);

  if (error !== undefined) assert.ok(error instanceof ForbiddenError);

  return error === undefined;
};

describe('requireSameOrigin', () => {
  it('refuses a state-changing request with no Origin and no Sec-Fetch-Site', () => {
    assert.equal(passes('POST'), false);
    assert.equal(passes('DELETE'), false);
  });

  it('refuses no Origin with a Sec-Fetch-Site other than same-origin', () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      assert.equal(passes('POST', { 'sec-fetch-site': site }), false, site);
    }
  });

  it('admits no Origin when Sec-Fetch-Site is same-origin', () => {
    assert.equal(passes('POST', { 'sec-fetch-site': 'same-origin' }), true);
  });

  it('admits our own origin', () => {
    assert.equal(passes('POST', { origin: APP_ORIGIN }), true);
  });

  it('refuses another origin, even when Sec-Fetch-Site says same-origin', () => {
    assert.equal(passes('POST', { origin: 'https://evil.example' }), false);
  });

  it('admits a null origin only from a same-origin navigation', () => {
    assert.equal(
      passes('POST', { origin: 'null', 'sec-fetch-site': 'same-origin' }),
      true,
    );
    assert.equal(passes('POST', { origin: 'null' }), false);
    assert.equal(
      passes('POST', { origin: 'null', 'sec-fetch-site': 'cross-site' }),
      false,
    );
  });

  it('never inspects a safe method', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(passes(method), true, method);
    }
  });
});
