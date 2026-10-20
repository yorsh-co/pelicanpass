import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Request } from 'express';

import { actorOf } from './actor.ts';

const ATTENDEE_ID = '557b4826-dd30-4f2e-b90a-caa21eff7b35';
const CHECKIN_ID = '964ab636-9c7c-47c2-a5c7-71f217fba0b4';

/** Only the fields `actorOf` reads; the rest of a Request is irrelevant here. */
const request = (fields: Record<string, unknown>): Request =>
  ({ ip: '10.0.0.1', ...fields }) as unknown as Request;

describe('actorOf', () => {
  it('records the required session as a stable handle, not its ID', () => {
    const req = request({
      session: { type: 'attendee' },
      sessionId: ATTENDEE_ID,
      sessionIds: { attendee: ATTENDEE_ID },
    });

    const actor = actorOf(req);

    assert.equal(actor.actorType, 'attendee');
    assert.match(actor.actorId ?? '', /^[0-9a-f]{16}$/);
    assert.notEqual(actor.actorId, ATTENDEE_ID);
    assert.equal(actorOf(req).actorId, actor.actorId);
    assert.equal(actor.ip, '10.0.0.1');
  });

  it('hashes a resolved session when the route required none', () => {
    const actor = actorOf(request({ sessionIds: { checkin: CHECKIN_ID } }));

    assert.equal(actor.actorType, 'checkin');
    assert.match(actor.actorId ?? '', /^[0-9a-f]{16}$/);
    assert.ok(!CHECKIN_ID.includes(actor.actorId ?? ''));
  });

  it('gives one session the same handle whichever branch records it', () => {
    const required = actorOf(
      request({ session: { type: 'attendee' }, sessionId: ATTENDEE_ID }),
    );
    const resolved = actorOf(
      request({ sessionIds: { attendee: ATTENDEE_ID } }),
    );

    assert.equal(required.actorId, resolved.actorId);
  });

  it('records an anonymous request with no actor', () => {
    const actor = actorOf(request({}));

    assert.equal(actor.actorType, 'anon');
    assert.equal(actor.actorId, undefined);
  });
});
