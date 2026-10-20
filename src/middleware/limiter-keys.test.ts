import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { panelKey, sessionKey } from './limiter-keys.ts';

const SESSION_ID = '964ab636-9c7c-47c2-a5c7-71f217fba0b4';

describe('sessionKey', () => {
  it('skips a request with nothing to key on', () => {
    for (const id of [null, undefined, '']) {
      assert.equal(sessionKey(id), null, JSON.stringify(id));
    }
  });

  it('keys on a stable digest, never the ID itself', () => {
    const key = sessionKey(SESSION_ID);

    assert.match(key ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(key, SESSION_ID);
    assert.equal(sessionKey(SESSION_ID), key);
  });
});

describe('panelKey', () => {
  it('shows addresses and global keys verbatim', () => {
    assert.equal(panelKey('ip', '10.0.0.1'), '10.0.0.1');
    assert.equal(panelKey('global', 'global'), 'global');
  });

  it('shortens every other key to a digest prefix', () => {
    for (const basis of [
      'session',
      'cookie',
      'username',
      'attendee',
      'volunteer',
      'admin',
      undefined,
    ] as const) {
      const shown = panelKey(basis, SESSION_ID);

      assert.match(shown, /^[0-9a-f]{12}$/, String(basis));
      assert.ok(!SESSION_ID.includes(shown), String(basis));
    }
  });

  it('keeps one bucket recognisable across refreshes', () => {
    assert.equal(panelKey('username', 'admin'), panelKey('username', 'admin'));
    assert.notEqual(panelKey('username', 'admin'), panelKey('username', 'ana'));
  });
});
