import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clearCaptchaRequirement,
  recordFailedAttempt,
} from './checkin.attempts.ts';
import { createCheckinSession } from './checkin.session.model.ts';

import type { Request } from 'express';

import type { FailableStep } from './checkin.attempts.ts';
import type { CheckinSession } from '../../types/session.ts';

/** The factory reads only the User-Agent from the request. */
const req = { headers: { 'user-agent': 'test' } } as unknown as Request;

/** Records `times` consecutive failures against a step. */
const fail = (
  session: CheckinSession,
  step: FailableStep,
  times: number,
): CheckinSession => {
  let current = session;

  for (let i = 0; i < times; i++) current = recordFailedAttempt(current, step);

  return current;
};

describe('recordFailedAttempt', () => {
  it('flags the session on the tenth qr failure and not before', () => {
    const session = createCheckinSession(req);

    const ninth = fail(session, 'qr', 9);
    assert.equal(ninth.failedAttempts.qr, 9);
    assert.equal(ninth.captchaRequired, false);

    const tenth = recordFailedAttempt(ninth, 'qr');
    assert.equal(tenth.failedAttempts.qr, 10);
    assert.equal(tenth.captchaRequired, true);
  });

  it('counts each step on its own', () => {
    const updated = fail(createCheckinSession(req), 'verification', 4);

    assert.equal(updated.failedAttempts.verification, 4);
    assert.equal(updated.failedAttempts.qr, 0);
    assert.equal(updated.failedAttempts.ticket, 0);
  });

  it('does not let failures on other steps count toward the qr threshold', () => {
    const updated = fail(fail(createCheckinSession(req), 'ticket', 4), 'qr', 9);

    assert.equal(updated.captchaRequired, false);
  });

  it('keeps the flag raised once set', () => {
    const flagged = fail(createCheckinSession(req), 'qr', 10);

    assert.equal(recordFailedAttempt(flagged, 'ticket').captchaRequired, true);
  });

  it('does not mutate the session it is given', () => {
    const session = createCheckinSession(req);
    const snapshot = structuredClone(session);

    recordFailedAttempt(session, 'qr');

    assert.deepEqual(session, snapshot);
  });
});

describe('clearCaptchaRequirement', () => {
  it('lowers the flag and zeroes every counter', () => {
    const flagged = fail(createCheckinSession(req), 'qr', 10);

    const cleared = clearCaptchaRequirement(flagged);

    assert.equal(cleared.captchaRequired, false);
    assert.deepEqual(cleared.failedAttempts, {
      ticket: 0,
      verification: 0,
      qr: 0,
    });
  });

  it('does not mutate the session it is given', () => {
    const flagged = fail(createCheckinSession(req), 'qr', 10);
    const snapshot = structuredClone(flagged);

    clearCaptchaRequirement(flagged);

    assert.deepEqual(flagged, snapshot);
  });
});
