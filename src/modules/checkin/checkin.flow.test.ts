import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyPresence, applyStep, validateStep } from './checkin.flow.ts';
import { createCheckinSession } from './checkin.session.model.ts';
import {
  ConflictError,
  NotMarkedPresentError,
} from '../../shared/errors/app-error.ts';

import type { Request } from 'express';

import type { CheckinSession } from '../../types/session.ts';

/** The factory reads only the User-Agent from the request. */
const req = { headers: { 'user-agent': 'test' } } as unknown as Request;

/** A session that has cleared the ticket step and awaits verification. */
const ticketed = (overrides: Partial<CheckinSession> = {}): CheckinSession => {
  const session = createCheckinSession(req);

  return {
    ...session,
    progress: { ...session.progress, ticket: true },
    currentStep: 'verification',
    attendeeId: 'attendee-1',
    ticket: { ticketCode: 'xabc12' },
    checkinComplete: false,
    ...overrides,
  };
};

/** A session that has cleared verification and waits on the qr step. */
const verified = (overrides: Partial<CheckinSession> = {}): CheckinSession => {
  const session = ticketed();

  return {
    ...session,
    progress: { ...session.progress, verified: true },
    currentStep: 'qr',
    ...overrides,
  };
};

describe('applyStep', () => {
  describe('verification', () => {
    it('skips the qr step when the attendee has been marked present', () => {
      const updated = applyStep(ticketed(), 'verification', {
        checkinComplete: true,
      });

      assert.equal(updated.progress.verified, true);
      assert.equal(updated.progress.qr, true);
      assert.equal(updated.currentStep, 'success');
    });

    it('moves on to the qr step when the attendee is not present', () => {
      const updated = applyStep(ticketed(), 'verification', {
        checkinComplete: false,
      });

      assert.equal(updated.progress.verified, true);
      assert.equal(updated.progress.qr, false);
      assert.equal(updated.currentStep, 'qr');
    });
  });

  describe('ticket', () => {
    it('skips the qr step when the attendee is already present', () => {
      const session = createCheckinSession(req);

      const updated = applyStep(session, 'ticket', { checkinComplete: true });

      assert.equal(updated.progress.ticket, true);
      assert.equal(updated.progress.qr, true);
      assert.equal(updated.currentStep, 'verification');
    });
  });

  it('does not mutate the session it is given', () => {
    const session = ticketed();
    const snapshot = structuredClone(session);

    applyStep(session, 'verification', { checkinComplete: true });

    assert.deepEqual(session, snapshot);
  });
});

describe('validateStep', () => {
  it('rejects verification before the ticket step is cleared', () => {
    assert.throws(() => {
      validateStep(createCheckinSession(req), 'verification');
    }, ConflictError);
  });
});

describe('applyPresence', () => {
  it('clears the qr step when the attendee is marked present', () => {
    const updated = applyPresence(verified(), true);

    assert.equal(updated.progress.qr, true);
    assert.equal(updated.checkinComplete, true);
    assert.equal(updated.currentStep, 'success');
    assert.equal(typeof updated.qr.timestamp, 'number');
  });

  it('refuses an attendee who is not marked present', () => {
    assert.throws(
      () => applyPresence(verified(), false),
      NotMarkedPresentError,
    );
  });

  it('refuses a session that has not been verified', () => {
    assert.throws(() => applyPresence(ticketed(), true), ConflictError);
  });

  it('does not mutate the session it is given', () => {
    const session = verified();
    const snapshot = structuredClone(session);

    applyPresence(session, true);

    assert.deepEqual(session, snapshot);
  });
});
